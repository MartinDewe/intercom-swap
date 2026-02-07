#!/usr/bin/env node
import process from 'node:process';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { PublicKey } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  getAccount,
  getAssociatedTokenAddress,
} from '@solana/spl-token';

import { ScBridgeClient } from '../src/sc-bridge/client.js';
import { createUnsignedEnvelope, attachSignature } from '../src/protocol/signedMessage.js';
import { KIND, ASSET, PAIR, STATE } from '../src/swap/constants.js';
import { PAIR as PRICE_PAIR } from '../src/price/providers.js';
import { validateSwapEnvelope } from '../src/swap/schema.js';
import { hashUnsignedEnvelope } from '../src/swap/hash.js';
import { createInitialTrade, applySwapEnvelope } from '../src/swap/stateMachine.js';
import { verifySwapPrePayOnchain } from '../src/swap/verify.js';
import { normalizeClnNetwork } from '../src/ln/cln.js';
import { claimEscrowTx } from '../src/solana/lnUsdtEscrowClient.js';
import { readSolanaKeypair } from '../src/solana/keypair.js';
import { SolanaRpcPool } from '../src/solana/rpcPool.js';
import { openTradeReceiptsStore } from '../src/receipts/store.js';

const execFileP = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const defaultComposeFile = path.join(repoRoot, 'dev/ln-regtest/docker-compose.yml');

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) flags.set(key, true);
      else {
        flags.set(key, next);
        i += 1;
      }
    } else {
      args.push(a);
    }
  }
  return { args, flags };
}

function requireFlag(flags, name) {
  const v = flags.get(name);
  if (!v || v === true) die(`Missing --${name}`);
  return String(v);
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (value === true) return true;
  const s = String(value).trim().toLowerCase();
  if (!s) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(s);
}

function parseIntFlag(value, label, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) die(`Invalid ${label}`);
  return n;
}

function parseBps(value, label, fallback) {
  const n = parseIntFlag(value, label, fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(10_000, n));
}

function stripSignature(envelope) {
  if (!envelope || typeof envelope !== 'object') return envelope;
  const { sig: _sig, signer: _signer, ...unsigned } = envelope;
  return unsigned;
}

function ensureOk(res, label) {
  if (!res || typeof res !== 'object') throw new Error(`${label} failed (no response)`);
  if (res.type === 'error') throw new Error(`${label} failed: ${res.error}`);
  return res;
}

async function signViaBridge(sc, payload) {
  const res = await sc.sign(payload);
  if (res.type !== 'signed') throw new Error(`Unexpected sign response: ${JSON.stringify(res).slice(0, 120)}`);
  const signerHex = String(res.signer || '').trim().toLowerCase();
  const sigHex = String(res.sig || '').trim().toLowerCase();
  if (!signerHex || !sigHex) throw new Error('Signing failed (missing signer/sig)');
  return { signerHex, sigHex };
}

async function signSwapEnvelope(sc, unsignedEnvelope) {
  const { signerHex, sigHex } = await signViaBridge(sc, unsignedEnvelope);
  const signed = attachSignature(unsignedEnvelope, { signerPubKeyHex: signerHex, sigHex });
  const v = validateSwapEnvelope(signed);
  if (!v.ok) throw new Error(`Internal error: signed envelope invalid: ${v.error}`);
  return signed;
}

function asBigIntAmount(value) {
  try {
    const s = String(value ?? '').trim();
    if (!s) return null;
    return BigInt(s);
  } catch (_e) {
    return null;
  }
}

function impliedPriceUsdtPerBtc({ btcSats, usdtAmount, usdtDecimals }) {
  try {
    const sats = BigInt(String(btcSats));
    const amt = BigInt(String(usdtAmount));
    const denom = sats * (10n ** BigInt(String(usdtDecimals)));
    if (sats <= 0n || denom <= 0n) return null;
    // Return a micro-precision float: (amt * 1e8 / (sats * 10^dec)) rounded down to 1e-6.
    const priceMicro = (amt * 100000000n * 1000000n) / denom;
    return Number(priceMicro) / 1_000_000;
  } catch (_e) {
    return null;
  }
}

async function sendAndConfirm(connection, tx) {
  const sig = await connection.sendRawTransaction(tx.serialize());
  const conf = await connection.confirmTransaction(sig, 'confirmed');
  if (conf?.value?.err) {
    throw new Error(`Tx failed: ${JSON.stringify(conf.value.err)}`);
  }
  return sig;
}

async function lnCli({
  backend,
  composeFile,
  service,
  network,
  cliBin,
  args,
}) {
  const useDocker = backend === 'docker';
  const cmd = useDocker ? 'docker' : (cliBin || 'lightning-cli');
  const fullArgs = useDocker
    ? ['compose', '-f', composeFile, 'exec', '-T', service, 'lightning-cli', `--network=${network}`, ...args]
    : [`--network=${network}`, ...args];
  const { stdout } = await execFileP(cmd, fullArgs, { cwd: repoRoot, maxBuffer: 1024 * 1024 * 50 });
  const text = String(stdout || '').trim();
  try {
    return JSON.parse(text);
  } catch (_e) {
    return { result: text };
  }
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));

  const url = requireFlag(flags, 'url');
  const token = requireFlag(flags, 'token');
  const otcChannel = (flags.get('otc-channel') && String(flags.get('otc-channel')).trim()) || '0000intercomswapbtcusdt';
  const receiptsDbPath = flags.get('receipts-db') ? String(flags.get('receipts-db')).trim() : '';
  const persistPreimage = parseBool(flags.get('persist-preimage'), receiptsDbPath ? true : false);
  const stopAfterLnPay = parseBool(flags.get('stop-after-ln-pay'), false);

  const tradeId = (flags.get('trade-id') && String(flags.get('trade-id')).trim()) || `swap_${crypto.randomUUID()}`;

  const btcSats = parseIntFlag(flags.get('btc-sats'), 'btc-sats', 50_000);
  const usdtAmount = (flags.get('usdt-amount') && String(flags.get('usdt-amount')).trim()) || '100000000';
  const rfqValidSec = parseIntFlag(flags.get('rfq-valid-sec'), 'rfq-valid-sec', 60);

  const timeoutSec = parseIntFlag(flags.get('timeout-sec'), 'timeout-sec', 30);
  const rfqResendMs = parseIntFlag(flags.get('rfq-resend-ms'), 'rfq-resend-ms', 1200);
  const acceptResendMs = parseIntFlag(flags.get('accept-resend-ms'), 'accept-resend-ms', 1200);

  const onceExitDelayMs = parseIntFlag(flags.get('once-exit-delay-ms'), 'once-exit-delay-ms', 200);
  const once = parseBool(flags.get('once'), false);
  const debug = parseBool(flags.get('debug'), false);

  const priceGuard = parseBool(flags.get('price-guard'), true);
  const priceMaxAgeMs = parseIntFlag(flags.get('price-max-age-ms'), 'price-max-age-ms', 15_000);
  const takerMaxDiscountBps = parseBps(flags.get('taker-max-discount-bps'), 'taker-max-discount-bps', 200);

  const runSwap = parseBool(flags.get('run-swap'), false);
  const swapTimeoutSec = parseIntFlag(flags.get('swap-timeout-sec'), 'swap-timeout-sec', 300);
  const swapResendMs = parseIntFlag(flags.get('swap-resend-ms'), 'swap-resend-ms', 1200);

  const solRpcUrl = (flags.get('solana-rpc-url') && String(flags.get('solana-rpc-url')).trim()) || 'http://127.0.0.1:8899';
  const solKeypairPath = flags.get('solana-keypair') ? String(flags.get('solana-keypair')).trim() : '';
  const solMintStr = flags.get('solana-mint') ? String(flags.get('solana-mint')).trim() : '';
  const solDecimals = parseIntFlag(flags.get('solana-decimals'), 'solana-decimals', 6);

  const lnBackend = (flags.get('ln-backend') && String(flags.get('ln-backend')).trim()) || 'docker';
  const lnComposeFile = (flags.get('ln-compose-file') && String(flags.get('ln-compose-file')).trim()) || defaultComposeFile;
  const lnService = flags.get('ln-service') ? String(flags.get('ln-service')).trim() : '';
  const lnNetworkRaw = (flags.get('ln-network') && String(flags.get('ln-network')).trim()) || 'regtest';
  let lnNetwork;
  try {
    lnNetwork = normalizeClnNetwork(lnNetworkRaw);
  } catch (err) {
    die(err?.message ?? String(err));
  }
  const lnCliBin = flags.get('ln-cli-bin') ? String(flags.get('ln-cli-bin')).trim() : '';

  const receipts = receiptsDbPath ? openTradeReceiptsStore({ dbPath: receiptsDbPath }) : null;

  if (runSwap) {
    if (!solKeypairPath) die('Missing --solana-keypair (required when --run-swap 1)');
    if (!lnService && lnBackend === 'docker') die('Missing --ln-service (required when --ln-backend docker)');
  }

  const sc = new ScBridgeClient({ url, token });
  await sc.connect();

  ensureOk(await sc.join(otcChannel), `join ${otcChannel}`);
  ensureOk(await sc.subscribe([otcChannel]), `subscribe ${otcChannel}`);

  const takerPubkey = String(sc.hello?.peer || '').trim().toLowerCase();
  if (!takerPubkey) die('SC-Bridge hello missing peer pubkey');

  const fetchBtcUsdtMedian = async () => {
    const res = await sc.priceGet();
    if (!res || typeof res !== 'object') return { ok: false, error: 'price_get failed (no response)', median: null };
    if (res.type === 'error') return { ok: false, error: String(res.error || 'price_get error'), median: null };
    if (res.type !== 'price_snapshot') return { ok: false, error: `unexpected price_get response: ${res.type}`, median: null };
    const snap = res;
    if (Number.isFinite(priceMaxAgeMs) && priceMaxAgeMs > 0) {
      const age = Date.now() - Number(snap.ts || 0);
      if (!Number.isFinite(age) || age > priceMaxAgeMs) {
        return { ok: false, error: `price snapshot stale (ageMs=${age})`, median: null };
      }
    }
    const feed = snap?.pairs?.[PRICE_PAIR.BTC_USDT];
    const median = Number(feed?.median);
    if (!feed?.ok || !Number.isFinite(median) || median <= 0) {
      return { ok: false, error: feed?.error || 'btc_usdt median unavailable', median: null };
    }
    return { ok: true, error: null, median };
  };

  const persistTrade = (patch, eventKind = null, eventPayload = null) => {
    if (!receipts) return;
    try {
      receipts.upsertTrade(tradeId, patch);
      if (eventKind) receipts.appendEvent(tradeId, eventKind, eventPayload);
    } catch (err) {
      try {
        receipts.upsertTrade(tradeId, { last_error: err?.message ?? String(err) });
      } catch (_e) {}
      if (debug) process.stderr.write(`[taker] receipts persist error: ${err?.message ?? String(err)}\n`);
    }
  };

  const sol = runSwap
    ? (() => {
        const payer = readSolanaKeypair(solKeypairPath);
        const pool = new SolanaRpcPool({ rpcUrls: solRpcUrl, commitment: 'confirmed' });
        return { payer, pool };
      })()
    : null;

  const nowSec = Math.floor(Date.now() / 1000);
  const rfqUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.RFQ,
    tradeId,
    body: {
      pair: PAIR.BTC_LN__USDT_SOL,
      direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
      btc_sats: btcSats,
      usdt_amount: usdtAmount,
      ...(runSwap ? { sol_recipient: sol.payer.publicKey.toBase58() } : {}),
      ...(runSwap && solMintStr ? { sol_mint: solMintStr } : {}),
      valid_until_unix: nowSec + rfqValidSec,
    },
  });
  const rfqId = hashUnsignedEnvelope(rfqUnsigned);
  const rfqSigned = await signSwapEnvelope(sc, rfqUnsigned);
  ensureOk(await sc.send(otcChannel, rfqSigned), 'send rfq');

  persistTrade(
    {
      role: 'taker',
      otc_channel: otcChannel,
      maker_peer: null,
      taker_peer: takerPubkey,
      btc_sats: btcSats,
      usdt_amount: usdtAmount,
      sol_mint: runSwap && solMintStr ? solMintStr : null,
      sol_recipient: runSwap ? sol.payer.publicKey.toBase58() : null,
      state: STATE.INIT,
    },
    'rfq_sent',
    rfqSigned
  );

  process.stdout.write(`${JSON.stringify({ type: 'ready', role: 'taker', otc_channel: otcChannel, trade_id: tradeId, rfq_id: rfqId, pubkey: takerPubkey })}\n`);

  let chosen = null; // { rfq_id, quote_id, quote }
  let joined = false;
  let done = false;
  let swapCtx = null; // { swapChannel, invite, trade, waiters, sent }

  const deadlineMs = Date.now() + timeoutSec * 1000;

  const maybeExit = () => {
    if (!once) return;
    if (!done) return;
    const delay = Number.isFinite(onceExitDelayMs) ? Math.max(onceExitDelayMs, 0) : 0;
    setTimeout(() => {
      try {
        receipts?.close();
      } catch (_e) {}
      sc.close();
      process.exit(0);
    }, delay);
  };

  const leaveSidechannel = async (channel) => {
    try {
      await sc.leave(channel);
    } catch (_e) {}
  };

  const resendRfqTimer = setInterval(async () => {
    try {
      if (chosen) return;
      if (Date.now() > deadlineMs) return;
      ensureOk(await sc.send(otcChannel, rfqSigned), 'resend rfq');
      if (debug) process.stderr.write(`[taker] resend rfq trade_id=${tradeId}\n`);
    } catch (err) {
      if (debug) process.stderr.write(`[taker] resend rfq error: ${err?.message ?? String(err)}\n`);
    }
  }, Math.max(rfqResendMs, 200));

  let quoteAcceptSigned = null;
  const resendAcceptTimer = setInterval(async () => {
    try {
      if (!chosen) return;
      if (joined) return;
      if (Date.now() > deadlineMs) return;
      if (!quoteAcceptSigned) return;
      ensureOk(await sc.send(otcChannel, quoteAcceptSigned), 'resend quote_accept');
      if (debug) process.stderr.write(`[taker] resend quote_accept trade_id=${tradeId} quote_id=${chosen.quote_id}\n`);
    } catch (err) {
      if (debug) process.stderr.write(`[taker] resend quote_accept error: ${err?.message ?? String(err)}\n`);
    }
  }, Math.max(acceptResendMs, 200));

  const stopTimers = () => {
    clearInterval(resendRfqTimer);
    clearInterval(resendAcceptTimer);
  };

  const enforceTimeout = setInterval(() => {
    if (Date.now() <= deadlineMs) return;
    stopTimers();
    die(`Timeout waiting for OTC handshake (timeout-sec=${timeoutSec})`);
  }, 200);

  const waitForSwapMessage = (match, { timeoutMs, label }) =>
    new Promise((resolve, reject) => {
      if (!swapCtx) return reject(new Error('swapCtx not initialized'));
      const timer = setTimeout(() => {
        swapCtx.waiters.delete(waiter);
        reject(new Error(`Timeout waiting for ${label}`));
      }, timeoutMs);
      const waiter = (msg) => {
        try {
          if (!match(msg)) return;
          clearTimeout(timer);
          swapCtx.waiters.delete(waiter);
          resolve(msg);
        } catch (err) {
          clearTimeout(timer);
          swapCtx.waiters.delete(waiter);
          reject(err);
        }
      };
      swapCtx.waiters.add(waiter);
    });

  const ensureAta = async ({ connection, payer, mint, owner }) => {
    const ata = await getAssociatedTokenAddress(mint, owner);
    try {
      await getAccount(connection, ata, 'confirmed');
      return ata;
    } catch (_e) {
      return createAssociatedTokenAccount(connection, payer, mint, owner);
    }
  };

  const startSwap = async ({ swapChannel, invite }) => {
    ensureOk(await sc.subscribe([swapChannel]), `subscribe ${swapChannel}`);

    swapCtx = {
      swapChannel,
      invite,
      trade: createInitialTrade(tradeId),
      waiters: new Set(),
      sent: {},
      done: false,
      deadlineMs: Date.now() + swapTimeoutSec * 1000,
      timers: new Set(),
    };

    persistTrade(
      {
        swap_channel: swapChannel,
        state: swapCtx.trade.state,
      },
      'swap_started',
      { swap_channel: swapChannel }
    );

    const clearTimers = () => {
      for (const tmr of swapCtx.timers) clearInterval(tmr);
      swapCtx.timers.clear();
    };

    const checkSwapDeadline = () => {
      if (Date.now() <= swapCtx.deadlineMs) return;
      clearTimers();
      die(`Timeout waiting for swap completion (swap-timeout-sec=${swapTimeoutSec})`);
    };

    // Send ready status with invite attached to accelerate authorization.
    const readyUnsigned = createUnsignedEnvelope({
      v: 1,
      kind: KIND.STATUS,
      tradeId,
      body: { state: STATE.INIT, note: 'ready' },
    });
    const readySigned = await signSwapEnvelope(sc, readyUnsigned);
    swapCtx.sent.ready = readySigned;
    await sc.send(swapChannel, readySigned, { invite });
    process.stdout.write(`${JSON.stringify({ type: 'swap_ready_sent', trade_id: tradeId, swap_channel: swapChannel })}\n`);
    persistTrade({ state: swapCtx.trade.state }, 'swap_ready_sent', readySigned);

    const readyTimer = setInterval(async () => {
      try {
        checkSwapDeadline();
        if (swapCtx.done) return;
        if (swapCtx.trade.state !== STATE.INIT) return;
        await sc.send(swapChannel, readySigned, { invite });
      } catch (_e) {}
    }, Math.max(swapResendMs, 200));
    swapCtx.timers.add(readyTimer);

    // Wait for terms.
    const termsMsg = await waitForSwapMessage((m) => m?.kind === KIND.TERMS && m?.trade_id === tradeId, {
      timeoutMs: swapTimeoutSec * 1000,
      label: 'TERMS',
    });

    // Verify Solana recipient matches our keypair before proceeding.
    const wantRecipient = sol.payer.publicKey.toBase58();
    const gotRecipient = String(termsMsg.body?.sol_recipient || '');
    if (gotRecipient !== wantRecipient) {
      throw new Error(`terms.sol_recipient mismatch (got=${gotRecipient} want=${wantRecipient})`);
    }
    if (solMintStr) {
      const gotMint = String(termsMsg.body?.sol_mint || '');
      if (gotMint !== solMintStr) throw new Error(`terms.sol_mint mismatch (got=${gotMint} want=${solMintStr})`);
    }

    const termsHash = hashUnsignedEnvelope(stripSignature(termsMsg));
    const acceptUnsigned = createUnsignedEnvelope({
      v: 1,
      kind: KIND.ACCEPT,
      tradeId,
      body: { terms_hash: termsHash },
    });
    const acceptSigned = await signSwapEnvelope(sc, acceptUnsigned);
    {
      const r = applySwapEnvelope(swapCtx.trade, acceptSigned);
      if (!r.ok) throw new Error(r.error);
      swapCtx.trade = r.trade;
    }
    swapCtx.sent.accept = acceptSigned;
    await sc.send(swapChannel, acceptSigned);
    process.stdout.write(`${JSON.stringify({ type: 'accept_sent', trade_id: tradeId, swap_channel: swapChannel })}\n`);
    persistTrade({ state: swapCtx.trade.state }, 'accept_sent', acceptSigned);

    const acceptTimer = setInterval(async () => {
      try {
        checkSwapDeadline();
        if (swapCtx.done) return;
        if (swapCtx.trade.state !== STATE.ACCEPTED && swapCtx.trade.state !== STATE.INIT && swapCtx.trade.state !== STATE.TERMS) return;
        if (swapCtx.trade.invoice) return;
        await sc.send(swapChannel, acceptSigned);
      } catch (_e) {}
    }, Math.max(swapResendMs, 200));
    swapCtx.timers.add(acceptTimer);

    // Wait for invoice + escrow proof.
    await waitForSwapMessage((m) => m?.kind === KIND.LN_INVOICE && m?.trade_id === tradeId, {
      timeoutMs: swapTimeoutSec * 1000,
      label: 'LN_INVOICE',
    });
    await waitForSwapMessage((m) => m?.kind === KIND.SOL_ESCROW_CREATED && m?.trade_id === tradeId, {
      timeoutMs: swapTimeoutSec * 1000,
      label: 'SOL_ESCROW_CREATED',
    });

    if (swapCtx.trade.invoice) {
      persistTrade(
        {
          ln_invoice_bolt11: swapCtx.trade.invoice.bolt11,
          ln_payment_hash_hex: swapCtx.trade.invoice.payment_hash_hex,
          state: swapCtx.trade.state,
        },
        'ln_invoice_recv',
        swapCtx.trade.invoice
      );
    }
    if (swapCtx.trade.escrow) {
      persistTrade(
        {
          sol_program_id: swapCtx.trade.escrow.program_id,
          sol_mint: swapCtx.trade.escrow.mint,
          sol_recipient: swapCtx.trade.escrow.recipient,
          sol_refund: swapCtx.trade.escrow.refund,
          sol_escrow_pda: swapCtx.trade.escrow.escrow_pda,
          sol_vault_ata: swapCtx.trade.escrow.vault_ata,
          sol_refund_after_unix: swapCtx.trade.escrow.refund_after_unix,
          state: swapCtx.trade.state,
        },
        'sol_escrow_recv',
        swapCtx.trade.escrow
      );
    }

    // Hard rule: verify escrow on-chain before paying.
    const prepay = await sol.pool.call(
      (connection) =>
        verifySwapPrePayOnchain({
          terms: swapCtx.trade.terms,
          invoiceBody: swapCtx.trade.invoice,
          escrowBody: swapCtx.trade.escrow,
          connection,
          now_unix: Math.floor(Date.now() / 1000),
        }),
      { label: 'taker:verify-prepay' }
    );
    if (!prepay.ok) throw new Error(`verify-prepay failed: ${prepay.error}`);

    if (priceGuard) {
      const px = await fetchBtcUsdtMedian();
      if (!px.ok) throw new Error(`price guard failed: ${px.error}`);
      const implied = impliedPriceUsdtPerBtc({
        btcSats: swapCtx.trade.terms.btc_sats,
        usdtAmount: swapCtx.trade.terms.usdt_amount,
        usdtDecimals: solDecimals,
      });
      if (implied === null || !Number.isFinite(implied) || implied <= 0) {
        throw new Error('price guard failed: implied price unavailable');
      }
      const discountBps = ((1 - (implied / px.median)) * 10_000);
      if (Number.isFinite(discountBps) && discountBps > takerMaxDiscountBps) {
        throw new Error(`price guard failed: discount_bps=${discountBps.toFixed(1)} max=${takerMaxDiscountBps}`);
      }
    }

    // Pay LN invoice and obtain preimage.
    const payRes = await lnCli({
      backend: lnBackend,
      composeFile: lnComposeFile,
      service: lnService,
      network: lnNetwork,
      cliBin: lnCliBin,
      args: ['pay', swapCtx.trade.invoice.bolt11],
    });
    const preimageHex = String(payRes?.payment_preimage || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(preimageHex)) throw new Error('LN pay missing payment_preimage');

    const paymentHashHex = String(swapCtx.trade.invoice.payment_hash_hex || '').trim().toLowerCase();

    const lnPaidUnsigned = createUnsignedEnvelope({
      v: 1,
      kind: KIND.LN_PAID,
      tradeId,
      body: { payment_hash_hex: paymentHashHex },
    });
    const lnPaidSigned = await signSwapEnvelope(sc, lnPaidUnsigned);
    {
      const r = applySwapEnvelope(swapCtx.trade, lnPaidSigned);
      if (!r.ok) throw new Error(r.error);
      swapCtx.trade = r.trade;
    }
    swapCtx.sent.ln_paid = lnPaidSigned;
    await sc.send(swapChannel, lnPaidSigned);
    process.stdout.write(`${JSON.stringify({ type: 'ln_paid_sent', trade_id: tradeId, swap_channel: swapChannel })}\n`);

    persistTrade(
      {
        ln_payment_hash_hex: paymentHashHex,
        ln_preimage_hex: persistPreimage ? preimageHex : null,
        state: swapCtx.trade.state,
      },
      'ln_paid',
      { payment_hash_hex: paymentHashHex }
    );

    if (stopAfterLnPay) {
      // Recovery path: operator can claim via `scripts/swaprecover.mjs claim ...`.
      swapCtx.done = true;
      done = true;
      clearTimers();
      process.stdout.write(`${JSON.stringify({ type: 'stopped_after_ln_pay', trade_id: tradeId, swap_channel: swapChannel })}\n`);
      await leaveSidechannel(swapChannel);
      try {
        receipts?.close();
      } catch (_e) {}
      sc.close();
      process.exit(0);
    }

    // Claim escrow on Solana.
    const mint = new PublicKey(swapCtx.trade.terms.sol_mint);
    const recipientToken = await sol.pool.call(
      (connection) =>
        ensureAta({
          connection,
          payer: sol.payer,
          mint,
          owner: sol.payer.publicKey,
        }),
      { label: 'taker:ensure-ata' }
    );
    const programId = swapCtx.trade.escrow?.program_id ? new PublicKey(swapCtx.trade.escrow.program_id) : undefined;
    const tradeFeeCollectorStr = swapCtx.trade.terms?.trade_fee_collector;
    if (!tradeFeeCollectorStr) throw new Error('Missing terms.trade_fee_collector');
    const { tx: claimTx } = await sol.pool.call(
      (connection) =>
        claimEscrowTx({
          connection,
          recipient: sol.payer,
          recipientTokenAccount: recipientToken,
          mint,
          paymentHashHex,
          preimageHex,
          tradeFeeCollector: new PublicKey(String(tradeFeeCollectorStr)),
          ...(programId ? { programId } : {}),
        }),
      { label: 'taker:build-claim-tx' }
    );
    const claimSig = await sol.pool.call((connection) => sendAndConfirm(connection, claimTx), { label: 'taker:send-claim-tx' });

    const solClaimedUnsigned = createUnsignedEnvelope({
      v: 1,
      kind: KIND.SOL_CLAIMED,
      tradeId,
      body: {
        payment_hash_hex: paymentHashHex,
        escrow_pda: swapCtx.trade.escrow.escrow_pda,
        tx_sig: claimSig,
      },
    });
    const solClaimedSigned = await signSwapEnvelope(sc, solClaimedUnsigned);
    swapCtx.sent.sol_claimed = solClaimedSigned;
    await sc.send(swapChannel, solClaimedSigned);
    process.stdout.write(`${JSON.stringify({ type: 'sol_claimed_sent', trade_id: tradeId, swap_channel: swapChannel, tx_sig: claimSig })}\n`);
    persistTrade({ state: swapCtx.trade.state }, 'sol_claimed', solClaimedSigned);

    // Best-effort: resend final proofs a few times to reduce "sent but peer exited" flakiness.
    for (let i = 0; i < 3; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        await sc.send(swapChannel, solClaimedSigned);
      } catch (_e) {}
    }

    swapCtx.done = true;
    done = true;
    clearTimers();
    process.stdout.write(`${JSON.stringify({ type: 'swap_done', trade_id: tradeId, swap_channel: swapChannel })}\n`);
    persistTrade({ state: STATE.CLAIMED }, 'swap_done', { trade_id: tradeId, swap_channel: swapChannel });
    await leaveSidechannel(swapChannel);
    maybeExit();
  };

  sc.on('sidechannel_message', async (evt) => {
    try {
      if (swapCtx && evt?.channel === swapCtx.swapChannel) {
        const msg = evt?.message;
        if (!msg || typeof msg !== 'object') return;
        const v = validateSwapEnvelope(msg);
        if (!v.ok) return;
        const r = applySwapEnvelope(swapCtx.trade, msg);
        if (r.ok) swapCtx.trade = r.trade;
        for (const waiter of swapCtx.waiters) {
          try {
            waiter(msg);
          } catch (_e) {}
        }
        return;
      }

      if (evt?.channel !== otcChannel) return;
      const msg = evt?.message;
      if (!msg || typeof msg !== 'object') return;

      if (msg.kind === KIND.QUOTE) {
        if (String(msg.trade_id) !== tradeId) return;
        const v = validateSwapEnvelope(msg);
        if (!v.ok) return;
        const quoteUnsigned = stripSignature(msg);
        const quoteId = hashUnsignedEnvelope(quoteUnsigned);
        const rfqIdGot = String(msg.body?.rfq_id || '').trim().toLowerCase();
        if (rfqIdGot !== rfqId) return;

        const validUntil = Number(msg.body?.valid_until_unix);
        const now = Math.floor(Date.now() / 1000);
        if (Number.isFinite(validUntil) && validUntil <= now) {
          if (debug) process.stderr.write(`[taker] ignore expired quote quote_id=${quoteId}\n`);
          return;
        }

        if (!chosen) {
          // Guardrail: only accept quotes for the exact requested size.
          if (Number(msg.body?.btc_sats) !== Number(btcSats)) return;

          const quoteAmountStr = String(msg.body?.usdt_amount || '').trim();
          const quoteAmount = asBigIntAmount(quoteAmountStr);
          if (quoteAmount === null) return;

          // Guardrail: treat RFQ usdt_amount as a minimum when set (>0).
          const rfqMin = asBigIntAmount(usdtAmount) ?? 0n;
          if (rfqMin > 0n && quoteAmount < rfqMin) return;

          // Guardrail: if enabled, require oracle health + acceptable discount vs oracle price.
          if (priceGuard) {
            const px = await fetchBtcUsdtMedian();
            if (!px.ok) return;
            const implied = impliedPriceUsdtPerBtc({
              btcSats: msg.body.btc_sats,
              usdtAmount: quoteAmountStr,
              usdtDecimals: solDecimals,
            });
            if (implied === null || !Number.isFinite(implied) || implied <= 0) return;
            const discountBps = ((1 - (implied / px.median)) * 10_000);
            if (Number.isFinite(discountBps) && discountBps > takerMaxDiscountBps) {
              if (debug) {
                process.stderr.write(`[taker] reject quote (discount_bps=${discountBps.toFixed(1)} > max=${takerMaxDiscountBps}) quote_id=${quoteId}\n`);
              }
              return;
            }
          }

          chosen = { rfq_id: rfqId, quote_id: quoteId, quote: msg };
          const quoteAcceptUnsigned = createUnsignedEnvelope({
            v: 1,
            kind: KIND.QUOTE_ACCEPT,
            tradeId,
            body: {
              rfq_id: rfqId,
              quote_id: quoteId,
            },
          });
          quoteAcceptSigned = await signSwapEnvelope(sc, quoteAcceptUnsigned);
          ensureOk(await sc.send(otcChannel, quoteAcceptSigned), 'send quote_accept');
          if (debug) process.stderr.write(`[taker] accepted quote trade_id=${tradeId} quote_id=${quoteId}\n`);
          process.stdout.write(`${JSON.stringify({ type: 'quote_accepted', trade_id: tradeId, rfq_id: rfqId, quote_id: quoteId })}\n`);

          persistTrade({ state: STATE.INIT }, 'quote_accepted', quoteAcceptSigned);
        }
        return;
      }

      if (msg.kind === KIND.SWAP_INVITE) {
        if (String(msg.trade_id) !== tradeId) return;
        const v = validateSwapEnvelope(msg);
        if (!v.ok) return;
        if (!chosen) return;
        if (String(msg.body?.rfq_id || '').trim().toLowerCase() !== chosen.rfq_id) return;
        if (String(msg.body?.quote_id || '').trim().toLowerCase() !== chosen.quote_id) return;

        const swapChannel = String(msg.body?.swap_channel || '').trim();
        if (!swapChannel) return;

        const invite = msg.body?.invite || null;
        const welcome = msg.body?.welcome || null;

        // Best-effort: ensure the invite is for us (defense-in-depth).
        const invitee = String(invite?.payload?.inviteePubKey || '').trim().toLowerCase();
        if (invitee && invitee !== takerPubkey) return;

        ensureOk(await sc.join(swapChannel, { invite, welcome }), `join ${swapChannel}`);
        joined = true;
        stopTimers();
        clearInterval(enforceTimeout);
        process.stdout.write(`${JSON.stringify({ type: 'swap_joined', trade_id: tradeId, swap_channel: swapChannel })}\n`);

        persistTrade(
          {
            swap_channel: swapChannel,
            maker_peer: msg.body?.owner_pubkey ? String(msg.body.owner_pubkey).trim().toLowerCase() : null,
          },
          'swap_joined',
          { swap_channel: swapChannel }
        );

        if (!runSwap) {
          if (once) await leaveSidechannel(swapChannel);
          done = true;
          maybeExit();
          return;
        }

        // Swap state machine is run asynchronously; the process stays alive.
        startSwap({ swapChannel, invite }).catch(async (err) => {
          await leaveSidechannel(swapChannel);
          die(err?.stack || err?.message || String(err));
        });
      }
    } catch (err) {
      if (debug) process.stderr.write(`[taker] error: ${err?.message ?? String(err)}\n`);
    }
  });

  // Keep process alive.
  await new Promise(() => {});
}

main().catch((err) => die(err?.stack || err?.message || String(err)));
