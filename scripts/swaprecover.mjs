#!/usr/bin/env node
import process from 'node:process';

import { PublicKey } from '@solana/web3.js';
import {
  createAssociatedTokenAccount,
  getAccount,
  getAssociatedTokenAddress,
} from '@solana/spl-token';

import { openTradeReceiptsStore } from '../src/receipts/store.js';
import { readSolanaKeypair } from '../src/solana/keypair.js';
import { SolanaRpcPool } from '../src/solana/rpcPool.js';
import { claimEscrowTx, refundEscrowTx, getEscrowState } from '../src/solana/lnUsdtEscrowClient.js';

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function usage() {
  return `
swaprecover (local-only recovery + receipts)

Commands:
  list --receipts-db <path> [--limit <n>]
  show --receipts-db <path> (--trade-id <id> | --payment-hash <hex32>)
  claim --receipts-db <path> (--trade-id <id> | --payment-hash <hex32>) --solana-rpc-url <url[,url2,...]> --solana-keypair <path> [--commitment <confirmed|finalized|processed>]
  refund --receipts-db <path> (--trade-id <id> | --payment-hash <hex32>) --solana-rpc-url <url[,url2,...]> --solana-keypair <path> [--commitment <confirmed|finalized|processed>]

Notes:
  - Receipts DB should live under onchain/ (gitignored).
  - claim requires ln_preimage_hex to be present in the receipt (or you must re-export it from your LN node first).
  - refund requires the Solana keypair that matches trade.sol_refund (the escrow depositor/refund authority).
`.trim();
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

function normalizeHex32(value, label) {
  const hex = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) die(`${label} must be 32-byte hex`);
  return hex;
}

async function ensureAta({ connection, payer, mint, owner }) {
  const ata = await getAssociatedTokenAddress(mint, owner);
  try {
    await getAccount(connection, ata, 'confirmed');
    return ata;
  } catch (_e) {
    return createAssociatedTokenAccount(connection, payer, mint, owner);
  }
}

async function sendAndConfirm(connection, tx, commitment = 'confirmed') {
  const sig = await connection.sendRawTransaction(tx.serialize());
  const conf = await connection.confirmTransaction(sig, commitment);
  if (conf?.value?.err) {
    throw new Error(`Tx failed: ${JSON.stringify(conf.value.err)}`);
  }
  return sig;
}

function pickTrade(store, { tradeId, paymentHashHex }) {
  if (tradeId) {
    const t = store.getTrade(tradeId);
    if (!t) die(`Trade not found: trade_id=${tradeId}`);
    return t;
  }
  if (paymentHashHex) {
    const t = store.getTradeByPaymentHash(paymentHashHex);
    if (!t) die(`Trade not found for payment_hash=${paymentHashHex}`);
    return t;
  }
  die('Missing --trade-id or --payment-hash');
}

async function main() {
  const { args, flags } = parseArgs(process.argv.slice(2));
  const cmd = args[0] || '';
  if (!cmd || cmd === 'help' || cmd === '--help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const receiptsDbPath = requireFlag(flags, 'receipts-db');
  const store = openTradeReceiptsStore({ dbPath: receiptsDbPath });
  try {
    if (cmd === 'list') {
      const limitRaw = flags.get('limit');
      const limit = limitRaw ? Math.max(1, Math.min(1000, Number.parseInt(String(limitRaw), 10))) : 50;
      const trades = store.listTrades({ limit });
      process.stdout.write(`${JSON.stringify({ type: 'list', trades }, null, 2)}\n`);
      return;
    }

    if (cmd === 'show') {
      const tradeId = flags.get('trade-id') ? String(flags.get('trade-id')).trim() : '';
      const paymentHashHex = flags.get('payment-hash')
        ? normalizeHex32(flags.get('payment-hash'), 'payment-hash')
        : '';
      const trade = pickTrade(store, { tradeId: tradeId || null, paymentHashHex: paymentHashHex || null });
      process.stdout.write(`${JSON.stringify({ type: 'trade', trade }, null, 2)}\n`);
      return;
    }

    if (cmd === 'claim') {
      const tradeId = flags.get('trade-id') ? String(flags.get('trade-id')).trim() : '';
      const paymentHashHex = flags.get('payment-hash')
        ? normalizeHex32(flags.get('payment-hash'), 'payment-hash')
        : '';

      const trade = pickTrade(store, { tradeId: tradeId || null, paymentHashHex: paymentHashHex || null });
      const hash = normalizeHex32(trade.ln_payment_hash_hex, 'ln_payment_hash_hex');
      const preimage = normalizeHex32(trade.ln_preimage_hex, 'ln_preimage_hex');
      const mint = trade.sol_mint ? new PublicKey(trade.sol_mint) : null;
      if (!mint) die('Trade missing sol_mint (cannot claim).');
      const programId = trade.sol_program_id ? new PublicKey(trade.sol_program_id) : null;
      if (!programId) die('Trade missing sol_program_id (cannot claim).');

      const rpcUrl = requireFlag(flags, 'solana-rpc-url');
      const keyPath = requireFlag(flags, 'solana-keypair');
      const commitment = flags.get('commitment') ? String(flags.get('commitment')).trim() : 'confirmed';

      const recipient = readSolanaKeypair(keyPath);
      const pool = new SolanaRpcPool({ rpcUrls: rpcUrl, commitment });

      const onchain = await pool.call((connection) => getEscrowState(connection, hash, programId, commitment), { label: 'escrow-get' });
      if (!onchain) die('Escrow not found on chain.');
      if (Number(onchain.status) !== 0) {
        die(`Escrow not active (status=${onchain.status}). Refusing to claim.`);
      }
      const tradeFeeCollector = onchain.tradeFeeCollector || null;
      if (!tradeFeeCollector) die('Escrow missing trade fee collector (cannot build claim).');

      const recipientToken = await pool.call(
        (connection) =>
          ensureAta({
            connection,
            payer: recipient,
            mint,
            owner: recipient.publicKey,
          }),
        { label: 'ensure-recipient-ata' }
      );

      const { tx } = await pool.call(
        (connection) =>
          claimEscrowTx({
            connection,
            recipient,
            recipientTokenAccount: recipientToken,
            mint,
            paymentHashHex: hash,
            preimageHex: preimage,
            tradeFeeCollector,
            programId,
          }),
        { label: 'claim:build-tx' }
      );
      const sig = await pool.call((connection) => sendAndConfirm(connection, tx, commitment), { label: 'claim:send' });

      store.upsertTrade(trade.trade_id, { state: 'claimed' });
      store.appendEvent(trade.trade_id, 'recovery_claim', { tx_sig: sig, payment_hash_hex: hash });

      process.stdout.write(`${JSON.stringify({ type: 'claimed', trade_id: trade.trade_id, payment_hash_hex: hash, tx_sig: sig }, null, 2)}\n`);
      return;
    }

    if (cmd === 'refund') {
      const tradeId = flags.get('trade-id') ? String(flags.get('trade-id')).trim() : '';
      const paymentHashHex = flags.get('payment-hash')
        ? normalizeHex32(flags.get('payment-hash'), 'payment-hash')
        : '';

      const trade = pickTrade(store, { tradeId: tradeId || null, paymentHashHex: paymentHashHex || null });
      const hash = normalizeHex32(trade.ln_payment_hash_hex, 'ln_payment_hash_hex');
      const mint = trade.sol_mint ? new PublicKey(trade.sol_mint) : null;
      if (!mint) die('Trade missing sol_mint (cannot refund).');
      const programId = trade.sol_program_id ? new PublicKey(trade.sol_program_id) : null;
      if (!programId) die('Trade missing sol_program_id (cannot refund).');
      const refundAddr = trade.sol_refund ? new PublicKey(trade.sol_refund) : null;
      if (!refundAddr) die('Trade missing sol_refund (cannot refund).');

      const rpcUrl = requireFlag(flags, 'solana-rpc-url');
      const keyPath = requireFlag(flags, 'solana-keypair');
      const commitment = flags.get('commitment') ? String(flags.get('commitment')).trim() : 'confirmed';

      const refund = readSolanaKeypair(keyPath);
      if (!refund.publicKey.equals(refundAddr)) {
        die(`Refund keypair pubkey mismatch (got=${refund.publicKey.toBase58()} want=${refundAddr.toBase58()})`);
      }

      const pool = new SolanaRpcPool({ rpcUrls: rpcUrl, commitment });

      const onchain = await pool.call((connection) => getEscrowState(connection, hash, programId, commitment), { label: 'escrow-get' });
      if (!onchain) die('Escrow not found on chain.');
      if (Number(onchain.status) !== 0) {
        die(`Escrow not active (status=${onchain.status}). Refusing to refund.`);
      }

      const refundToken = await pool.call(
        (connection) =>
          ensureAta({
            connection,
            payer: refund,
            mint,
            owner: refund.publicKey,
          }),
        { label: 'ensure-refund-ata' }
      );

      const { tx } = await pool.call(
        (connection) =>
          refundEscrowTx({
            connection,
            refund,
            refundTokenAccount: refundToken,
            mint,
            paymentHashHex: hash,
            programId,
          }),
        { label: 'refund:build-tx' }
      );
      const sig = await pool.call((connection) => sendAndConfirm(connection, tx, commitment), { label: 'refund:send' });

      store.upsertTrade(trade.trade_id, { state: 'refunded' });
      store.appendEvent(trade.trade_id, 'recovery_refund', { tx_sig: sig, payment_hash_hex: hash });

      process.stdout.write(`${JSON.stringify({ type: 'refunded', trade_id: trade.trade_id, payment_hash_hex: hash, tx_sig: sig }, null, 2)}\n`);
      return;
    }

    die(`Unknown command: ${cmd}`);
  } finally {
    store.close();
  }
}

main().catch((err) => die(err?.stack || err?.message || String(err)));
