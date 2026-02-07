#!/usr/bin/env node
import process from 'node:process';

import { PublicKey } from '@solana/web3.js';
import {
  createAssociatedTokenAccount,
  getAccount,
  getAssociatedTokenAddress,
} from '@solana/spl-token';

import { readSolanaKeypair } from '../src/solana/keypair.js';
import { SolanaRpcPool } from '../src/solana/rpcPool.js';
import {
  LN_USDT_ESCROW_PROGRAM_ID,
  deriveConfigPda,
  deriveFeeVaultAta,
  deriveTradeConfigPda,
  deriveTradeFeeVaultAta,
  getConfigState,
  getTradeConfigState,
  getEscrowState,
  initConfigTx,
  initTradeConfigTx,
  setConfigTx,
  setTradeConfigTx,
  withdrawTradeFeesTx,
  withdrawFeesTx,
} from '../src/solana/lnUsdtEscrowClient.js';

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function usage() {
  return `
escrowctl (Solana LN<->SPL escrow program operator tool)

Global flags:
  --solana-rpc-url <url[,url2,...]>   (default: http://127.0.0.1:8899)
  --commitment <processed|confirmed|finalized> (default: confirmed)
  --program-id <base58>               (default: LN_USDT_ESCROW_PROGRAM_ID)

Key flags (for signing commands):
  --solana-keypair <path>             (required for config-init/config-set/fees-withdraw)

Commands:
  config-get
  config-init --fee-bps <n> [--fee-collector <pubkey>] [--simulate 0|1]
  config-set  --fee-bps <n> [--fee-collector <pubkey>] [--simulate 0|1]
  fees-balance --mint <pubkey>
  fees-withdraw --mint <pubkey> [--amount <u64>] [--create-ata 0|1] [--simulate 0|1]
  trade-config-get --fee-collector <pubkey>
  trade-config-init --fee-bps <n> [--fee-collector <pubkey>] [--simulate 0|1]
  trade-config-set  --fee-bps <n> [--fee-collector <pubkey>] [--simulate 0|1]
  trade-fees-balance --fee-collector <pubkey> --mint <pubkey>
  trade-fees-withdraw --mint <pubkey> [--amount <u64>] [--create-ata 0|1] [--simulate 0|1]
  escrow-get --payment-hash <hex32>

Notes:
  - In this fork, the program enforces: config authority == fee_collector.
  - For WithdrawFees, --amount 0 (default) means "withdraw all".
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

function parseU64(value, label, fallback = 0n) {
  if (value === undefined || value === null || value === '') return fallback;
  try {
    const x = BigInt(String(value).trim());
    if (x < 0n) die(`Invalid ${label} (negative)`);
    return x;
  } catch (_e) {
    die(`Invalid ${label}`);
  }
}

async function sendAndConfirm(connection, tx, commitment) {
  const sig = await connection.sendRawTransaction(tx.serialize());
  const conf = await connection.confirmTransaction(sig, commitment);
  if (conf?.value?.err) throw new Error(`Tx failed: ${JSON.stringify(conf.value.err)}`);
  return sig;
}

async function main() {
  const { args, flags } = parseArgs(process.argv.slice(2));
  const cmd = args[0] || '';

  if (!cmd || cmd === 'help' || cmd === '--help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const rpcUrl = (flags.get('solana-rpc-url') && String(flags.get('solana-rpc-url')).trim()) || 'http://127.0.0.1:8899';
  const commitment = (flags.get('commitment') && String(flags.get('commitment')).trim()) || 'confirmed';
  const programIdStr = (flags.get('program-id') && String(flags.get('program-id')).trim()) || '';
  const programId = programIdStr ? new PublicKey(programIdStr) : LN_USDT_ESCROW_PROGRAM_ID;
  const pool = new SolanaRpcPool({ rpcUrls: rpcUrl, commitment });

  if (cmd === 'config-get') {
    const { pda: configPda } = deriveConfigPda(programId);
    const state = await pool.call((connection) => getConfigState(connection, programId, commitment), { label: 'config-get' });
    process.stdout.write(
      `${JSON.stringify(
        {
          type: 'config_state',
          program_id: programId.toBase58(),
          config_pda: configPda.toBase58(),
          state: state
            ? {
                v: state.v,
                authority: state.authority.toBase58(),
                fee_collector: state.feeCollector.toBase58(),
                fee_bps: state.feeBps,
                bump: state.bump,
              }
            : null,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (cmd === 'trade-config-get') {
    const feeCollectorStr = requireFlag(flags, 'fee-collector').trim();
    const feeCollector = new PublicKey(feeCollectorStr);
    const { pda: tradeConfigPda } = deriveTradeConfigPda(feeCollector, programId);
    const state = await pool.call((connection) => getTradeConfigState(connection, feeCollector, programId, commitment), { label: 'trade-config-get' });
    process.stdout.write(
      `${JSON.stringify(
        {
          type: 'trade_config_state',
          program_id: programId.toBase58(),
          trade_config_pda: tradeConfigPda.toBase58(),
          fee_collector: feeCollector.toBase58(),
          state: state
            ? {
                v: state.v,
                authority: state.authority.toBase58(),
                fee_collector: state.feeCollector.toBase58(),
                fee_bps: state.feeBps,
                bump: state.bump,
              }
            : null,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (cmd === 'escrow-get') {
    const paymentHashHex = requireFlag(flags, 'payment-hash').trim().toLowerCase();
    const state = await pool.call((connection) => getEscrowState(connection, paymentHashHex, programId, commitment), { label: 'escrow-get' });
    process.stdout.write(
      `${JSON.stringify(
        {
          type: 'escrow_state',
          program_id: programId.toBase58(),
          payment_hash_hex: paymentHashHex,
          state: state
            ? {
                v: state.v,
                status: state.status,
                payment_hash_hex: state.paymentHashHex,
                recipient: state.recipient.toBase58(),
                refund: state.refund.toBase58(),
                refund_after_unix: Number(state.refundAfter),
                mint: state.mint.toBase58(),
                net_amount: state.netAmount !== undefined ? state.netAmount.toString() : state.amount.toString(),
                fee_amount: state.feeAmount ? state.feeAmount.toString() : '0',
                fee_bps: state.feeBps || 0,
                fee_collector: state.feeCollector ? state.feeCollector.toBase58() : null,
                vault: state.vault.toBase58(),
                bump: state.bump,
              }
            : null,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (cmd === 'fees-balance') {
    const mintStr = requireFlag(flags, 'mint').trim();
    const mint = new PublicKey(mintStr);
    const { pda: configPda } = deriveConfigPda(programId);
    const feeVaultAta = await deriveFeeVaultAta(configPda, mint);
    let amount = 0n;
    try {
      const acct = await pool.call((connection) => getAccount(connection, feeVaultAta, commitment), { label: 'fees-balance' });
      amount = acct.amount;
    } catch (_e) {
      amount = 0n;
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          type: 'fee_vault_balance',
          program_id: programId.toBase58(),
          mint: mint.toBase58(),
          config_pda: configPda.toBase58(),
          fee_vault_ata: feeVaultAta.toBase58(),
          amount: amount.toString(),
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (cmd === 'trade-fees-balance') {
    const feeCollectorStr = requireFlag(flags, 'fee-collector').trim();
    const feeCollector = new PublicKey(feeCollectorStr);
    const mintStr = requireFlag(flags, 'mint').trim();
    const mint = new PublicKey(mintStr);
    const { pda: tradeConfigPda } = deriveTradeConfigPda(feeCollector, programId);
    const feeVaultAta = await deriveTradeFeeVaultAta(tradeConfigPda, mint);
    let amount = 0n;
    try {
      const acct = await pool.call((connection) => getAccount(connection, feeVaultAta, commitment), { label: 'trade-fees-balance' });
      amount = acct.amount;
    } catch (_e) {
      amount = 0n;
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          type: 'trade_fee_vault_balance',
          program_id: programId.toBase58(),
          mint: mint.toBase58(),
          trade_config_pda: tradeConfigPda.toBase58(),
          fee_vault_ata: feeVaultAta.toBase58(),
          amount: amount.toString(),
        },
        null,
        2
      )}\n`
    );
    return;
  }

  // Signing commands below.
  const keypairPath = requireFlag(flags, 'solana-keypair');
  const signer = readSolanaKeypair(keypairPath);

  if (cmd === 'config-init' || cmd === 'config-set') {
    const feeBps = parseIntFlag(requireFlag(flags, 'fee-bps'), 'fee-bps');
    const feeCollectorStr = (flags.get('fee-collector') && String(flags.get('fee-collector')).trim()) || '';
    const feeCollector = feeCollectorStr ? new PublicKey(feeCollectorStr) : signer.publicKey;
    const simulate = parseBool(flags.get('simulate'), false);

    if (!feeCollector.equals(signer.publicKey)) {
      die('Invalid --fee-collector: this program requires fee_collector == authority (signer).');
    }

    const build = cmd === 'config-init' ? initConfigTx : setConfigTx;
    const { tx, configPda } = await pool.call(
      (connection) =>
        build({
          connection,
          ...(cmd === 'config-init' ? { payer: signer } : { authority: signer }),
          feeCollector,
          feeBps,
          programId,
        }),
      { label: cmd }
    );

    if (simulate) {
      const sim = await pool.call((connection) => connection.simulateTransaction(tx, { commitment }), { label: `${cmd}:simulate` });
      process.stdout.write(
        `${JSON.stringify(
          {
            type: 'simulate',
            cmd,
            program_id: programId.toBase58(),
            config_pda: configPda.toBase58(),
            result: sim?.value ?? null,
          },
          null,
          2
        )}\n`
      );
      return;
    }

    const sig = await pool.call((connection) => sendAndConfirm(connection, tx, commitment), { label: cmd });
    process.stdout.write(
      `${JSON.stringify(
        {
          type: cmd === 'config-init' ? 'config_inited' : 'config_set',
          program_id: programId.toBase58(),
          config_pda: configPda.toBase58(),
          fee_collector: feeCollector.toBase58(),
          fee_bps: feeBps,
          tx_sig: sig,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (cmd === 'trade-config-init' || cmd === 'trade-config-set') {
    const feeBps = parseIntFlag(requireFlag(flags, 'fee-bps'), 'fee-bps');
    const feeCollectorStr = (flags.get('fee-collector') && String(flags.get('fee-collector')).trim()) || '';
    const feeCollector = feeCollectorStr ? new PublicKey(feeCollectorStr) : signer.publicKey;
    const simulate = parseBool(flags.get('simulate'), false);

    if (!feeCollector.equals(signer.publicKey)) {
      die('Invalid --fee-collector: trade config requires fee_collector == authority (signer).');
    }

    const build = cmd === 'trade-config-init' ? initTradeConfigTx : setTradeConfigTx;
    const { tx, tradeConfigPda } = await pool.call(
      (connection) =>
        build({
          connection,
          ...(cmd === 'trade-config-init' ? { payer: signer } : { authority: signer }),
          feeCollector,
          feeBps,
          programId,
        }),
      { label: cmd }
    );

    if (simulate) {
      const sim = await pool.call((connection) => connection.simulateTransaction(tx, { commitment }), { label: `${cmd}:simulate` });
      process.stdout.write(
        `${JSON.stringify(
          {
            type: 'simulate',
            cmd,
            program_id: programId.toBase58(),
            trade_config_pda: tradeConfigPda.toBase58(),
            result: sim?.value ?? null,
          },
          null,
          2
        )}\n`
      );
      return;
    }

    const sig = await pool.call((connection) => sendAndConfirm(connection, tx, commitment), { label: cmd });
    process.stdout.write(
      `${JSON.stringify(
        {
          type: cmd === 'trade-config-init' ? 'trade_config_inited' : 'trade_config_set',
          program_id: programId.toBase58(),
          trade_config_pda: tradeConfigPda.toBase58(),
          fee_collector: feeCollector.toBase58(),
          fee_bps: feeBps,
          tx_sig: sig,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (cmd === 'fees-withdraw') {
    const mintStr = requireFlag(flags, 'mint').trim();
    const mint = new PublicKey(mintStr);
    const amount = parseU64(flags.get('amount'), 'amount', 0n);
    const createAta = parseBool(flags.get('create-ata'), true);
    const simulate = parseBool(flags.get('simulate'), false);

    const destAta = await getAssociatedTokenAddress(mint, signer.publicKey, false);
    if (createAta) {
      await pool.call(async (connection) => {
        try {
          await getAccount(connection, destAta, commitment);
        } catch (_e) {
          await createAssociatedTokenAccount(connection, signer, mint, signer.publicKey);
        }
      }, { label: 'ensure-dest-ata' });
    }

    const { tx, feeVaultAta, configPda } = await pool.call(
      (connection) =>
        withdrawFeesTx({
          connection,
          feeCollector: signer,
          feeCollectorTokenAccount: destAta,
          mint,
          amount,
          programId,
        }),
      { label: 'fees-withdraw:build' }
    );

    if (simulate) {
      const sim = await pool.call((connection) => connection.simulateTransaction(tx, { commitment }), { label: 'fees-withdraw:simulate' });
      process.stdout.write(
        `${JSON.stringify(
          {
            type: 'simulate',
            cmd,
            program_id: programId.toBase58(),
            config_pda: configPda.toBase58(),
            fee_vault_ata: feeVaultAta.toBase58(),
            dest_ata: destAta.toBase58(),
            amount: amount.toString(),
            result: sim?.value ?? null,
          },
          null,
          2
        )}\n`
      );
      return;
    }

    const sig = await pool.call((connection) => sendAndConfirm(connection, tx, commitment), { label: 'fees-withdraw' });
    process.stdout.write(
      `${JSON.stringify(
        {
          type: 'fees_withdrawn',
          program_id: programId.toBase58(),
          config_pda: configPda.toBase58(),
          mint: mint.toBase58(),
          fee_vault_ata: feeVaultAta.toBase58(),
          dest_ata: destAta.toBase58(),
          amount: amount.toString(),
          tx_sig: sig,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (cmd === 'trade-fees-withdraw') {
    const mintStr = requireFlag(flags, 'mint').trim();
    const mint = new PublicKey(mintStr);
    const amount = parseU64(flags.get('amount'), 'amount', 0n);
    const createAta = parseBool(flags.get('create-ata'), true);
    const simulate = parseBool(flags.get('simulate'), false);

    const destAta = await getAssociatedTokenAddress(mint, signer.publicKey, false);
    if (createAta) {
      await pool.call(async (connection) => {
        try {
          await getAccount(connection, destAta, commitment);
        } catch (_e) {
          await createAssociatedTokenAccount(connection, signer, mint, signer.publicKey);
        }
      }, { label: 'ensure-dest-ata' });
    }

    const { tx, feeVaultAta, tradeConfigPda } = await pool.call(
      (connection) =>
        withdrawTradeFeesTx({
          connection,
          feeCollector: signer,
          feeCollectorTokenAccount: destAta,
          mint,
          amount,
          programId,
        }),
      { label: 'trade-fees-withdraw:build' }
    );

    if (simulate) {
      const sim = await pool.call((connection) => connection.simulateTransaction(tx, { commitment }), { label: 'trade-fees-withdraw:simulate' });
      process.stdout.write(
        `${JSON.stringify(
          {
            type: 'simulate',
            cmd,
            program_id: programId.toBase58(),
            trade_config_pda: tradeConfigPda.toBase58(),
            fee_vault_ata: feeVaultAta.toBase58(),
            dest_ata: destAta.toBase58(),
            amount: amount.toString(),
            result: sim?.value ?? null,
          },
          null,
          2
        )}\n`
      );
      return;
    }

    const sig = await pool.call((connection) => sendAndConfirm(connection, tx, commitment), { label: 'trade-fees-withdraw' });
    process.stdout.write(
      `${JSON.stringify(
        {
          type: 'trade_fees_withdrawn',
          program_id: programId.toBase58(),
          trade_config_pda: tradeConfigPda.toBase58(),
          mint: mint.toBase58(),
          fee_vault_ata: feeVaultAta.toBase58(),
          dest_ata: destAta.toBase58(),
          amount: amount.toString(),
          tx_sig: sig,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  die(`Unknown command: ${cmd}`);
}

main().catch((err) => die(err?.stack || err?.message || String(err)));
