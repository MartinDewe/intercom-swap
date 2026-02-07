#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { PublicKey } from '@solana/web3.js';
import {
  createAssociatedTokenAccount,
  getAccount,
  getAssociatedTokenAddress,
} from '@solana/spl-token';

import { SolanaRpcPool } from '../src/solana/rpcPool.js';
import { ScBridgeClient } from '../src/sc-bridge/client.js';
import { createUnsignedEnvelope, attachSignature } from '../src/protocol/signedMessage.js';
import { KIND, ASSET, PAIR, STATE } from '../src/swap/constants.js';
import { PAIR as PRICE_PAIR } from '../src/price/providers.js';
import { validateSwapEnvelope } from '../src/swap/schema.js';
import { hashUnsignedEnvelope } from '../src/swap/hash.js';
import { createInitialTrade, applySwapEnvelope } from '../src/swap/stateMachine.js';
import { normalizeInvitePayload, normalizeWelcomePayload, createSignedInvite } from '../src/sidechannel/capabilities.js';
import { normalizeClnNetwork } from '../src/ln/cln.js';
import {
  createEscrowTx,
  getConfigState,
  getTradeConfigState,
  LN_USDT_ESCROW_PROGRAM_ID,
} from '../src/solana/lnUsdtEscrowClient.js';
import { readSolanaKeypair } from '../src/solana/keypair.js';
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

function quoteUsdtAmountFromOracle({ btcSats, priceUsdtPerBtc, usdtDecimals, spreadBps = 0 }) {
  const sats = BigInt(String(btcSats));
  const decimals = BigInt(String(usdtDecimals));
  const scale = 10n ** decimals;
  const priceMicro = BigInt(Math.round(Number(priceUsdtPerBtc) * 1_000_000));
  if (priceMicro <= 0n) return null;

  const denom = 100000000n * 1000000n;
  let amount = (sats * priceMicro * scale) / denom;
  const bps = BigInt(Math.max(0, Math.min(10_000, Number(spreadBps) || 0)));
  if (bps > 0n) amount = (amount * (10000n - bps)) / 10000n;
  if (amount < 0n) amount = 0n;
  return amount.toString();
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
  const swapChannelTemplate =
    (flags.get('swap-channel-template') && String(flags.get('swap-channel-template')).trim()) || 'swap:{trade_id}';
  const quoteValidSec = parseIntFlag(flags.get('quote-valid-sec'), 'quote-valid-sec', 60);
  const inviteTtlSec = parseIntFlag(flags.get('invite-ttl-sec'), 'invite-ttl-sec', 7 * 24 * 3600);
  const onceExitDelayMs = parseIntFlag(flags.get('once-exit-delay-ms'), 'once-exit-delay-ms', 750);
  const once = parseBool(flags.get('once'), false);
  const debug = parseBool(flags.get('debug'), false);

  const priceGuard = parseBool(flags.get('price-guard'), true);
  const priceMaxAgeMs = parseIntFlag(flags.get('price-max-age-ms'), 'price-max-age-ms', 15_000);
  const makerSpreadBps = parseBps(flags.get('maker-spread-bps'), 'maker-spread-bps', 0);
  const makerMaxOverpayBps = parseBps(flags.get('maker-max-overpay-bps'), 'maker-max-overpay-bps', 0);

  const receiptsDbPath = flags.get('receipts-db') ? String(flags.get('receipts-db')).trim() : '';

  const runSwap = parseBool(flags.get('run-swap'), false);
  const swapTimeoutSec = parseIntFlag(flags.get('swap-timeout-sec'), 'swap-timeout-sec', 300);
  const swapResendMs = parseIntFlag(flags.get('swap-resend-ms'), 'swap-resend-ms', 1200);
  const termsValidSec = parseIntFlag(flags.get('terms-valid-sec'), 'terms-valid-sec', 300);
  const solRefundAfterSec = parseIntFlag(flags.get('solana-refund-after-sec'), 'solana-refund-after-sec', 3600);

  const solRpcUrl = (flags.get('solana-rpc-url') && String(flags.get('solana-rpc-url')).trim()) || 'http://127.0.0.1:8899';
  const solKeypairPath = flags.get('solana-keypair') ? String(flags.get('solana-keypair')).trim() : '';
  const solMintStr = flags.get('solana-mint') ? String(flags.get('solana-mint')).trim() : '';
  const solDecimals = parseIntFlag(flags.get('solana-decimals'), 'solana-decimals', 6);
  const solProgramIdStr = flags.get('solana-program-id') ? String(flags.get('solana-program-id')).trim() : '';
  const solTradeFeeCollectorStr = flags.get('solana-trade-fee-collector')
    ? String(flags.get('solana-trade-fee-collector')).trim()
    : '';

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
    if (!solMintStr) die('Missing --solana-mint (required when --run-swap 1)');
    if (!lnService && lnBackend === 'docker') die('Missing --ln-service (required when --ln-backend docker)');
  }

  const sc = new ScBridgeClient({ url, token });
  await sc.connect();
  ensureOk(await sc.join(otcChannel), `join ${otcChannel}`);
  ensureOk(await sc.subscribe([otcChannel]), `subscribe ${otcChannel}`);

  const makerPubkey = String(sc.hello?.peer || '').trim().toLowerCase();
  if (!makerPubkey) die('SC-Bridge hello missing peer pubkey');

  const quotes = new Map(); // quote_id -> { rfq_id, trade_id, btc_sats, usdt_amount, sol_recipient, sol_mint }
  const swaps = new Map(); // swap_channel -> ctx

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

  const persistTrade = (tradeId, patch, eventKind = null, eventPayload = null) => {
    if (!receipts) return;
    try {
      receipts.upsertTrade(tradeId, patch);
      if (eventKind) receipts.appendEvent(tradeId, eventKind, eventPayload);
    } catch (err) {
      try {
        receipts.upsertTrade(tradeId, { last_error: err?.message ?? String(err) });
      } catch (_e) {}
      if (debug) process.stderr.write(`[maker] receipts persist error: ${err?.message ?? String(err)}\n`);
    }
  };

  const sol = runSwap
	    ? (() => {
	        const payer = readSolanaKeypair(solKeypairPath);
	        const pool = new SolanaRpcPool({ rpcUrls: solRpcUrl, commitment: 'confirmed' });
	        const mint = new PublicKey(solMintStr);
	        const programId = solProgramIdStr ? new PublicKey(solProgramIdStr) : LN_USDT_ESCROW_PROGRAM_ID;
	        const tradeFeeCollector = solTradeFeeCollectorStr ? new PublicKey(solTradeFeeCollectorStr) : null;
	        return { payer, pool, mint, programId, tradeFeeCollector };
	      })()
	    : null;

  let done = false;

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

  const cancelSwap = async (ctx, reason) => {
    try {
      const cancelUnsigned = createUnsignedEnvelope({
        v: 1,
        kind: KIND.CANCEL,
        tradeId: ctx.tradeId,
        body: { reason: String(reason || 'canceled') },
      });
      const cancelSigned = await signSwapEnvelope(sc, cancelUnsigned);
      await sc.send(ctx.swapChannel, cancelSigned);
    } catch (_e) {}
  };

  const cleanupSwap = async (ctx, { reason = null, sendCancel = false } = {}) => {
    if (!ctx || ctx.cleanedUp) return;
    ctx.cleanedUp = true;
    if (ctx.resender) clearInterval(ctx.resender);
    try {
      swaps.delete(ctx.swapChannel);
    } catch (_e) {}
    if (sendCancel) {
      // Best-effort: cancellation is only accepted before escrow creation.
      await cancelSwap(ctx, reason || 'swap timeout');
    }
    persistTrade(
      ctx.tradeId,
      {
        state: ctx.trade.state,
        last_error: reason ? String(reason) : null,
      },
      'swap_cleanup',
      { trade_id: ctx.tradeId, swap_channel: ctx.swapChannel, reason: reason ? String(reason) : null }
    );
    await leaveSidechannel(ctx.swapChannel);
  };

  const createAndSendTerms = async (ctx) => {
    const nowSec = Math.floor(Date.now() / 1000);

    // Fees are part of the agreed terms.
    // Platform fee comes from the program config PDA.
    // Trade fee comes from a trade-config PDA keyed by trade_fee_collector.
    let platformFeeBps = 0;
    let platformFeeCollector = null;
    let tradeFeeBps = 0;
    let tradeFeeCollector = null;
    if (runSwap) {
      const cfg = await sol.pool.call(
        (connection) => getConfigState(connection, sol.programId, 'confirmed'),
        { label: 'maker:get-config' }
      );
      if (!cfg) throw new Error('Solana escrow program config is not initialized (run escrowctl config-init first)');
      platformFeeBps = Number(cfg.feeBps || 0);
      platformFeeCollector = cfg.feeCollector;

      tradeFeeCollector = sol.tradeFeeCollector || cfg.feeCollector;
      const tradeCfg = await sol.pool.call(
        (connection) => getTradeConfigState(connection, tradeFeeCollector, sol.programId, 'confirmed'),
        { label: 'maker:get-trade-config' }
      );
      if (!tradeCfg) {
        throw new Error(`Trade fee config not initialized for ${tradeFeeCollector.toBase58()}`);
      }
      tradeFeeBps = Number(tradeCfg.feeBps || 0);
    }

    const termsUnsigned = createUnsignedEnvelope({
      v: 1,
      kind: KIND.TERMS,
      tradeId: ctx.tradeId,
      body: {
        pair: PAIR.BTC_LN__USDT_SOL,
        direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
        btc_sats: ctx.btcSats,
        usdt_amount: ctx.usdtAmount,
        usdt_decimals: solDecimals,
        sol_mint: sol.mint.toBase58(),
        sol_recipient: ctx.solRecipient,
        sol_refund: sol.payer.publicKey.toBase58(),
        sol_refund_after_unix: nowSec + solRefundAfterSec,
        platform_fee_bps: platformFeeBps,
        platform_fee_collector: platformFeeCollector ? platformFeeCollector.toBase58() : null,
        trade_fee_bps: tradeFeeBps,
        trade_fee_collector: tradeFeeCollector ? tradeFeeCollector.toBase58() : null,
        ln_receiver_peer: makerPubkey,
        ln_payer_peer: ctx.inviteePubKey,
        terms_valid_until_unix: nowSec + termsValidSec,
      },
    });
    const signed = await signSwapEnvelope(sc, termsUnsigned);
    const applied = applySwapEnvelope(ctx.trade, signed);
    if (!applied.ok) throw new Error(applied.error);
    ctx.trade = applied.trade;
    ctx.sent.terms = signed;
    await sc.send(ctx.swapChannel, signed);
    process.stdout.write(`${JSON.stringify({ type: 'terms_sent', trade_id: ctx.tradeId, swap_channel: ctx.swapChannel })}\n`);

    persistTrade(
      ctx.tradeId,
      {
        role: 'maker',
        otc_channel: otcChannel,
        swap_channel: ctx.swapChannel,
        maker_peer: makerPubkey,
        taker_peer: ctx.inviteePubKey,
        btc_sats: ctx.btcSats,
        usdt_amount: ctx.usdtAmount,
        sol_mint: signed.body.sol_mint,
        sol_program_id: sol?.programId?.toBase58?.() ?? null,
        sol_recipient: signed.body.sol_recipient,
        sol_refund: signed.body.sol_refund,
        sol_refund_after_unix: signed.body.sol_refund_after_unix,
        state: ctx.trade.state,
      },
      'terms_sent',
      signed
    );
  };

  const ensureAta = async ({ connection, payer, mint, owner }) => {
    const ata = await getAssociatedTokenAddress(mint, owner);
    try {
      await getAccount(connection, ata, 'confirmed');
      return ata;
    } catch (_e) {
      // Create ATA if missing (payer funds rent).
      return createAssociatedTokenAccount(connection, payer, mint, owner);
    }
  };

  const createInvoiceAndEscrow = async (ctx) => {
    if (ctx.startedSettlement) return;
    ctx.startedSettlement = true;

    const sats = ctx.btcSats;
    const invoice = await lnCli({
      backend: lnBackend,
      composeFile: lnComposeFile,
      service: lnService,
      network: lnNetwork,
      cliBin: lnCliBin,
      args: ['invoice', `${sats}sat`, ctx.tradeId, 'swap'],
    });

    const bolt11 = String(invoice?.bolt11 || '').trim();
    const paymentHashHex = String(invoice?.payment_hash || '').trim().toLowerCase();
    if (!bolt11) throw new Error('LN invoice missing bolt11');
    if (!/^[0-9a-f]{64}$/.test(paymentHashHex)) throw new Error('LN invoice missing payment_hash');

    ctx.paymentHashHex = paymentHashHex;

    const lnInvUnsigned = createUnsignedEnvelope({
      v: 1,
      kind: KIND.LN_INVOICE,
      tradeId: ctx.tradeId,
      body: {
        bolt11,
        payment_hash_hex: paymentHashHex,
        amount_msat: String(BigInt(sats) * 1000n),
      },
    });
    const lnInvSigned = await signSwapEnvelope(sc, lnInvUnsigned);
    {
      const r = applySwapEnvelope(ctx.trade, lnInvSigned);
      if (!r.ok) throw new Error(r.error);
      ctx.trade = r.trade;
    }
    ctx.sent.invoice = lnInvSigned;
    await sc.send(ctx.swapChannel, lnInvSigned);
    process.stdout.write(`${JSON.stringify({ type: 'ln_invoice_sent', trade_id: ctx.tradeId, swap_channel: ctx.swapChannel, payment_hash_hex: paymentHashHex })}\n`);

    persistTrade(
      ctx.tradeId,
      {
        ln_invoice_bolt11: bolt11,
        ln_payment_hash_hex: paymentHashHex,
        state: ctx.trade.state,
      },
      'ln_invoice_sent',
      lnInvSigned
    );

    // Solana escrow (locks net + platform fee + trade fee; terms.usdt_amount is the net amount).
    const refundAfterUnix = Number(ctx.trade.terms.sol_refund_after_unix);
    if (!Number.isFinite(refundAfterUnix) || refundAfterUnix <= 0) throw new Error('Invalid sol_refund_after_unix');

    const solRecipient = new PublicKey(ctx.solRecipient);
    const payerToken = await sol.pool.call(
      (connection) => ensureAta({ connection, payer: sol.payer, mint: sol.mint, owner: sol.payer.publicKey }),
      { label: 'maker:ensure-ata' }
    );

	    const { tx: escrowTx, escrowPda, vault } = await sol.pool.call(
	      (connection) =>
	        createEscrowTx({
	          connection,
	          payer: sol.payer,
	          payerTokenAccount: payerToken,
	          mint: sol.mint,
	          paymentHashHex,
	          recipient: solRecipient,
	          refund: sol.payer.publicKey,
	          refundAfterUnix,
	          amount: BigInt(String(ctx.usdtAmount)),
	          expectedPlatformFeeBps: Number(ctx.trade.terms.platform_fee_bps || 0),
	          expectedTradeFeeBps: Number(ctx.trade.terms.trade_fee_bps || 0),
	          tradeFeeCollector: new PublicKey(String(ctx.trade.terms.trade_fee_collector)),
	          programId: sol.programId,
	        }),
	      { label: 'maker:build-escrow-tx' }
	    );
    const escrowSig = await sol.pool.call((connection) => sendAndConfirm(connection, escrowTx), { label: 'maker:send-escrow-tx' });

    const solEscrowUnsigned = createUnsignedEnvelope({
      v: 1,
      kind: KIND.SOL_ESCROW_CREATED,
      tradeId: ctx.tradeId,
      body: {
        payment_hash_hex: paymentHashHex,
        program_id: sol.programId.toBase58(),
        escrow_pda: escrowPda.toBase58(),
        vault_ata: vault.toBase58(),
        mint: sol.mint.toBase58(),
        amount: String(ctx.usdtAmount),
        refund_after_unix: refundAfterUnix,
        recipient: solRecipient.toBase58(),
        refund: sol.payer.publicKey.toBase58(),
        tx_sig: escrowSig,
      },
    });
    const solEscrowSigned = await signSwapEnvelope(sc, solEscrowUnsigned);
    {
      const r = applySwapEnvelope(ctx.trade, solEscrowSigned);
      if (!r.ok) throw new Error(r.error);
      ctx.trade = r.trade;
    }
    ctx.sent.escrow = solEscrowSigned;
    await sc.send(ctx.swapChannel, solEscrowSigned);
    process.stdout.write(`${JSON.stringify({ type: 'sol_escrow_sent', trade_id: ctx.tradeId, swap_channel: ctx.swapChannel, tx_sig: escrowSig })}\n`);

    persistTrade(
      ctx.tradeId,
      {
        sol_program_id: solEscrowSigned.body.program_id,
        sol_mint: solEscrowSigned.body.mint,
        sol_escrow_pda: solEscrowSigned.body.escrow_pda,
        sol_vault_ata: solEscrowSigned.body.vault_ata,
        sol_refund_after_unix: solEscrowSigned.body.refund_after_unix,
        sol_recipient: solEscrowSigned.body.recipient,
        sol_refund: solEscrowSigned.body.refund,
        state: ctx.trade.state,
      },
      'sol_escrow_sent',
      solEscrowSigned
    );
  };

  const startSwapResender = (ctx) => {
    if (ctx.resender) return;
    ctx.resender = setInterval(async () => {
      try {
        if (ctx.done) return;
        if (Date.now() > ctx.deadlineMs) {
          ctx.done = true;
          await cleanupSwap(ctx, { reason: `swap timeout (swap-timeout-sec=${swapTimeoutSec})`, sendCancel: true });
          return;
        }
        if (ctx.trade.state === STATE.TERMS && ctx.sent.terms) {
          await sc.send(ctx.swapChannel, ctx.sent.terms);
        }
        if ([STATE.ACCEPTED, STATE.INVOICE, STATE.ESCROW].includes(ctx.trade.state) && ctx.sent.invoice && !ctx.trade.ln_paid) {
          await sc.send(ctx.swapChannel, ctx.sent.invoice);
        }
        if ([STATE.INVOICE, STATE.ESCROW].includes(ctx.trade.state) && ctx.sent.escrow && !ctx.trade.ln_paid) {
          await sc.send(ctx.swapChannel, ctx.sent.escrow);
        }
      } catch (_e) {}
    }, Math.max(swapResendMs, 200));
  };

  sc.on('sidechannel_message', async (evt) => {
    try {
      if (evt?.channel !== otcChannel && !swaps.has(evt?.channel)) return;
      const msg = evt?.message;
      if (!msg || typeof msg !== 'object') return;

      // Swap channel traffic
      if (swaps.has(evt.channel)) {
        const ctx = swaps.get(evt.channel);
        if (!ctx) return;
        const v = validateSwapEnvelope(msg);
        if (!v.ok) return;
        const r = applySwapEnvelope(ctx.trade, msg);
        if (!r.ok) {
          if (debug) process.stderr.write(`[maker] swap apply error: ${r.error}\n`);
          return;
        }
        ctx.trade = r.trade;

        if (msg.kind === KIND.ACCEPT && ctx.trade.state === STATE.ACCEPTED && runSwap) {
          await createInvoiceAndEscrow(ctx);
        }

        if (ctx.trade.state === STATE.CLAIMED && !ctx.done) {
          ctx.done = true;
          done = true;
          process.stdout.write(`${JSON.stringify({ type: 'swap_done', trade_id: ctx.tradeId, swap_channel: ctx.swapChannel })}\n`);
          persistTrade(ctx.tradeId, { state: ctx.trade.state }, 'swap_done', { trade_id: ctx.tradeId });
          await cleanupSwap(ctx, { reason: 'swap_done' });
          maybeExit();
        }
        return;
      }

      if (msg.kind === KIND.RFQ) {
        const v = validateSwapEnvelope(msg);
        if (!v.ok) return;
        const rfqUnsigned = stripSignature(msg);
        const rfqId = hashUnsignedEnvelope(rfqUnsigned);

        if (msg.body?.valid_until_unix !== undefined) {
          const nowSec = Math.floor(Date.now() / 1000);
          if (Number(msg.body.valid_until_unix) <= nowSec) {
            if (debug) process.stderr.write(`[maker] skip expired rfq trade_id=${msg.trade_id} rfq_id=${rfqId}\n`);
            return;
          }
        }

        const solRecipient = msg.body?.sol_recipient ? String(msg.body.sol_recipient).trim() : '';
        if (runSwap && !solRecipient) {
          if (debug) process.stderr.write(`[maker] skip rfq missing sol_recipient trade_id=${msg.trade_id} rfq_id=${rfqId}\n`);
          return;
        }

        let quoteUsdtAmount = String(msg.body.usdt_amount);
        if (priceGuard) {
          const px = await fetchBtcUsdtMedian();
          if (!px.ok) {
            if (debug) process.stderr.write(`[maker] skip rfq: price guard ${px.error}\n`);
            return;
          }

          const oracleAmount = quoteUsdtAmountFromOracle({
            btcSats: msg.body.btc_sats,
            priceUsdtPerBtc: px.median,
            usdtDecimals: solDecimals,
            spreadBps: makerSpreadBps,
          });
          if (!oracleAmount || oracleAmount === '0') {
            if (debug) process.stderr.write(`[maker] skip rfq: computed usdt_amount invalid\n`);
            return;
          }

          const rfqAmountTrimmed = String(msg.body.usdt_amount || '').trim();
          const rfqIsOpen = rfqAmountTrimmed === '' || rfqAmountTrimmed === '0';

          if (rfqIsOpen) {
            quoteUsdtAmount = oracleAmount;
          } else {
            const rfqPrice = impliedPriceUsdtPerBtc({
              btcSats: msg.body.btc_sats,
              usdtAmount: rfqAmountTrimmed,
              usdtDecimals: solDecimals,
            });
            if (rfqPrice === null || !Number.isFinite(rfqPrice) || rfqPrice <= 0) {
              // If RFQ cannot be evaluated, fall back to oracle-based quote.
              quoteUsdtAmount = oracleAmount;
            } else {
              const overpayBps = ((rfqPrice / px.median) - 1) * 10_000;
              if (Number.isFinite(overpayBps) && overpayBps <= makerMaxOverpayBps) {
                // RFQ price is acceptable for the maker: echo requested terms.
                quoteUsdtAmount = rfqAmountTrimmed;
              } else {
                // Counterquote based on oracle.
                quoteUsdtAmount = oracleAmount;
              }
            }
          }
        } else {
          // If no price guard is enabled, avoid quoting nonsensical "open RFQ" amounts.
          if (String(quoteUsdtAmount).trim() === '0') return;
        }

        // Quote at chosen terms.
        const nowSec = Math.floor(Date.now() / 1000);
        const quoteUnsigned = createUnsignedEnvelope({
          v: 1,
          kind: KIND.QUOTE,
          tradeId: String(msg.trade_id),
          body: {
            rfq_id: rfqId,
            pair: PAIR.BTC_LN__USDT_SOL,
            direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
            btc_sats: msg.body.btc_sats,
            usdt_amount: quoteUsdtAmount,
            ...(runSwap ? { sol_mint: sol.mint.toBase58(), sol_recipient: solRecipient } : {}),
            valid_until_unix: nowSec + quoteValidSec,
          },
        });
        const quoteId = hashUnsignedEnvelope(quoteUnsigned);
        const signed = await signSwapEnvelope(sc, quoteUnsigned);
        const sent = ensureOk(await sc.send(otcChannel, signed), 'send quote');
        if (debug) process.stderr.write(`[maker] quoted trade_id=${msg.trade_id} rfq_id=${rfqId} quote_id=${quoteId} sent=${sent.type}\n`);
        quotes.set(quoteId, {
          rfq_id: rfqId,
          trade_id: String(msg.trade_id),
          btc_sats: msg.body.btc_sats,
          usdt_amount: quoteUsdtAmount,
          sol_recipient: solRecipient,
          sol_mint: runSwap ? sol.mint.toBase58() : (msg.body?.sol_mint ? String(msg.body.sol_mint).trim() : ''),
        });
        return;
      }

      if (msg.kind === KIND.QUOTE_ACCEPT) {
        const v = validateSwapEnvelope(msg);
        if (!v.ok) return;
        const quoteId = String(msg.body.quote_id || '').trim().toLowerCase();
        const rfqId = String(msg.body.rfq_id || '').trim().toLowerCase();
        const known = quotes.get(quoteId);
        if (!known) return;
        if (known.rfq_id !== rfqId) return;

        const tradeId = String(msg.trade_id);
        const swapChannel = swapChannelTemplate.replaceAll('{trade_id}', tradeId);
        const inviteePubKey = String(msg.signer || '').trim().toLowerCase();
        if (!inviteePubKey) return;

        // Build welcome + invite signed by this peer (SC-Bridge signing).
        const welcomePayload = normalizeWelcomePayload({
          channel: swapChannel,
          ownerPubKey: makerPubkey,
          text: `swap ${tradeId}`,
          issuedAt: Date.now(),
          version: 1,
        });
        const { sigHex: welcomeSig } = await signViaBridge(sc, welcomePayload);
        const welcome = { payload: welcomePayload, sig: welcomeSig };

        const issuedAt = Date.now();
        const invitePayload = normalizeInvitePayload({
          channel: swapChannel,
          inviteePubKey,
          inviterPubKey: makerPubkey,
          inviterAddress: null,
          issuedAt,
          expiresAt: issuedAt + inviteTtlSec * 1000,
          nonce: Math.random().toString(36).slice(2, 10),
          version: 1,
        });
        const { sigHex: inviteSig } = await signViaBridge(sc, invitePayload);
        const invite = createSignedInvite(invitePayload, () => inviteSig, { welcome });

        const swapInviteUnsigned = createUnsignedEnvelope({
          v: 1,
          kind: KIND.SWAP_INVITE,
          tradeId,
          body: {
            rfq_id: rfqId,
            quote_id: quoteId,
            swap_channel: swapChannel,
            owner_pubkey: makerPubkey,
            invite,
            welcome,
          },
        });
        const swapInviteSigned = await signSwapEnvelope(sc, swapInviteUnsigned);
        ensureOk(await sc.send(otcChannel, swapInviteSigned), 'send swap_invite');
        ensureOk(await sc.join(swapChannel, { welcome }), `join ${swapChannel}`);
        ensureOk(await sc.subscribe([swapChannel]), `subscribe ${swapChannel}`);

        process.stdout.write(`${JSON.stringify({ type: 'swap_invite_sent', trade_id: tradeId, rfq_id: rfqId, quote_id: quoteId, swap_channel: swapChannel })}\n`);

        if (!runSwap) {
          if (once) await leaveSidechannel(swapChannel);
          done = true;
          maybeExit();
          return;
        }

        const ctx = {
          tradeId,
          rfqId,
          quoteId,
          swapChannel,
          inviteePubKey,
          btcSats: Number(known.btc_sats),
          usdtAmount: String(known.usdt_amount),
          solRecipient: String(known.sol_recipient),
          trade: createInitialTrade(tradeId),
          sent: {},
          startedSettlement: false,
          paymentHashHex: null,
          done: false,
          deadlineMs: Date.now() + swapTimeoutSec * 1000,
          resender: null,
        };
        swaps.set(swapChannel, ctx);

        // Begin swap: send terms and start the resend loop.
        await createAndSendTerms(ctx);
        startSwapResender(ctx);

        persistTrade(
          tradeId,
          {
            role: 'maker',
            otc_channel: otcChannel,
            swap_channel: swapChannel,
            maker_peer: makerPubkey,
            taker_peer: inviteePubKey,
            btc_sats: ctx.btcSats,
            usdt_amount: ctx.usdtAmount,
            sol_mint: runSwap ? sol.mint.toBase58() : null,
            sol_recipient: ctx.solRecipient,
            state: ctx.trade.state,
          },
          'swap_started',
          { trade_id: tradeId, swap_channel: swapChannel }
        );
      }
    } catch (err) {
      if (debug) process.stderr.write(`[maker] error: ${err?.message ?? String(err)}\n`);
    }
  });

  process.stdout.write(`${JSON.stringify({ type: 'ready', role: 'maker', otc_channel: otcChannel, pubkey: makerPubkey })}\n`);
  // Keep process alive.
  await new Promise(() => {});
}

main().catch((err) => die(err?.stack || err?.message || String(err)));
