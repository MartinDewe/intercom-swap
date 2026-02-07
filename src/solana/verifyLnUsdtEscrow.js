import { PublicKey } from '@solana/web3.js';
import { getAccount } from '@solana/spl-token';

import { deriveEscrowPda, deriveVaultAta, getEscrowState } from './lnUsdtEscrowClient.js';

const normalizeHex = (value) => String(value || '').trim().toLowerCase();
const normalizeB58 = (value) => String(value || '').trim();

function toPubkey(value, label) {
  try {
    return new PublicKey(normalizeB58(value));
  } catch (_e) {
    throw new Error(`${label} must be base58`);
  }
}

// Validates that a SOL_ESCROW_CREATED body corresponds to an actual on-chain escrow state.
// This is intended to be run by the LN payer *before* paying the invoice.
export async function verifyLnUsdtEscrowOnchain({
  connection,
  escrowBody,
  commitment = 'confirmed',
} = {}) {
  if (!connection) return { ok: false, error: 'connection is required', state: null };
  if (!escrowBody || typeof escrowBody !== 'object') {
    return { ok: false, error: 'escrowBody is required', state: null };
  }

  const paymentHashHex = normalizeHex(escrowBody.payment_hash_hex);
  if (!/^[0-9a-f]{64}$/.test(paymentHashHex)) {
    return { ok: false, error: 'escrowBody.payment_hash_hex must be 32-byte hex', state: null };
  }

  let programId;
  try {
    programId = toPubkey(escrowBody.program_id, 'escrowBody.program_id');
  } catch (err) {
    return { ok: false, error: err.message, state: null };
  }

  let mint;
  try {
    mint = toPubkey(escrowBody.mint, 'escrowBody.mint');
  } catch (err) {
    return { ok: false, error: err.message, state: null };
  }

  const { pda } = deriveEscrowPda(paymentHashHex, programId);
  const derivedEscrowPda = pda.toBase58();
  if (normalizeB58(escrowBody.escrow_pda) !== derivedEscrowPda) {
    return {
      ok: false,
      error: 'escrow_pda mismatch (derived vs message)',
      derived_escrow_pda: derivedEscrowPda,
      state: null,
    };
  }

  const vaultAta = await deriveVaultAta(pda, mint);
  const derivedVaultAta = vaultAta.toBase58();
  if (normalizeB58(escrowBody.vault_ata) !== derivedVaultAta) {
    return {
      ok: false,
      error: 'vault_ata mismatch (derived vs message)',
      derived_vault_ata: derivedVaultAta,
      state: null,
    };
  }

  const state = await getEscrowState(connection, paymentHashHex, programId, commitment);
  if (!state) {
    return { ok: false, error: 'escrow account not found on chain', state: null };
  }

  if (![2, 3].includes(state.v)) {
    return { ok: false, error: `escrow state version unsupported v=${state.v}`, state };
  }
  if (state.status !== 0) {
    return { ok: false, error: `escrow is not active (status=${state.status})`, state };
  }

  if (normalizeHex(state.paymentHashHex) !== paymentHashHex) {
    return { ok: false, error: 'escrow payment_hash mismatch vs message', state };
  }
  if (state.mint.toBase58() !== normalizeB58(escrowBody.mint)) {
    return { ok: false, error: 'escrow mint mismatch vs message', state };
  }
  if (state.recipient.toBase58() !== normalizeB58(escrowBody.recipient)) {
    return { ok: false, error: 'escrow recipient mismatch vs message', state };
  }
  if (state.refund.toBase58() !== normalizeB58(escrowBody.refund)) {
    return { ok: false, error: 'escrow refund mismatch vs message', state };
  }
  if (state.vault.toBase58() !== normalizeB58(escrowBody.vault_ata)) {
    return { ok: false, error: 'escrow vault mismatch vs message', state };
  }

  const wantNetAmount = BigInt(String(escrowBody.amount));
  if (state.netAmount !== wantNetAmount) {
    return {
      ok: false,
      error: `escrow net amount mismatch vs message (state=${state.netAmount} msg=${wantNetAmount})`,
      state,
    };
  }
  const wantRefundAfter = BigInt(String(escrowBody.refund_after_unix));
  if (state.refundAfter !== wantRefundAfter) {
    return {
      ok: false,
      error: 'escrow refund_after mismatch vs message',
      state,
    };
  }

  // Verify vault ATA owner + mint + amount.
  let vault = null;
  try {
    vault = await getAccount(connection, vaultAta, commitment);
  } catch (err) {
    return { ok: false, error: `failed to load vault ATA: ${err?.message ?? String(err)}`, state };
  }
  if (!vault.owner.equals(pda)) {
    return { ok: false, error: 'vault ATA owner mismatch vs escrow PDA', state };
  }
  if (!vault.mint.equals(mint)) {
    return { ok: false, error: 'vault ATA mint mismatch vs escrow mint', state };
  }
  const wantVaultAmount = wantNetAmount + BigInt(state.feeAmount || 0n);
  if (vault.amount !== wantVaultAmount) {
    return {
      ok: false,
      error: `vault ATA amount mismatch (vault=${vault.amount} want=${wantVaultAmount})`,
      state,
    };
  }

  return {
    ok: true,
    error: null,
    state,
    derived_escrow_pda: derivedEscrowPda,
    derived_vault_ata: derivedVaultAta,
  };
}
