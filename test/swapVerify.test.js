import test from 'node:test';
import assert from 'node:assert/strict';

import { verifySwapPrePay } from '../src/swap/verify.js';

test('swap verify: payer pre-pay checks (invoice + escrow + terms)', () => {
  const bolt11 =
    'lnbcrt50u1p5ctmrmsp59rehxdv7fmge9navus48wmze3lur2fgggtxvn6l7k79hvplc67rspp58kwsh4lqgaa3urr0d05u2vqzk89r0d4h5ndtvfpjx5d63lkm92qsdq8v3jhxccxqyjw5qcqp29qxpqysgqcvu675fp6ttyrq82jnsdydgav9fp236d4ve89wkr34jwu3syefaq9nftzqjmgdma0z0020j9qdrzmmnfs3cqwmp53fhtmw7u0cck0jcpwwrwrt';
  const paymentHashHex = '3d9d0bd7e0477b1e0c6f6be9c53002b1ca37b6b7a4dab62432351ba8fedb2a81';

  const terms = {
    btc_sats: 5000,
    usdt_amount: '1000000',
    sol_mint: 'So11111111111111111111111111111111111111112',
    sol_recipient: '11111111111111111111111111111111',
    sol_refund: '11111111111111111111111111111111',
    sol_refund_after_unix: 1770989000,
  };

  const invoiceBody = {
    bolt11,
    payment_hash_hex: paymentHashHex,
    amount_msat: '5000000',
    expires_at_unix: 1770989307,
  };

  const escrowBody = {
    payment_hash_hex: paymentHashHex,
    program_id: '4RS6xpspM1V2K7FKSqeSH6VVaZbtzHzhJqacwrz8gJrF',
    escrow_pda: '11111111111111111111111111111111',
    vault_ata: '11111111111111111111111111111111',
    mint: terms.sol_mint,
    amount: terms.usdt_amount,
    refund_after_unix: 1770990000,
    recipient: terms.sol_recipient,
    refund: terms.sol_refund,
    tx_sig: 'dummy_tx_sig_1',
  };

  const ok = verifySwapPrePay({
    terms,
    invoiceBody,
    escrowBody,
    now_unix: 1770988000,
  });
  assert.equal(ok.ok, true, ok.error);

  const badEscrow = verifySwapPrePay({
    terms,
    invoiceBody,
    escrowBody: { ...escrowBody, payment_hash_hex: '00'.repeat(32) },
    now_unix: 1770988000,
  });
  assert.equal(badEscrow.ok, false);
  assert.match(badEscrow.error, /payment_hash/i);

  const badInvoice = verifySwapPrePay({
    terms,
    invoiceBody: { ...invoiceBody, payment_hash_hex: '00'.repeat(32) },
    escrowBody,
    now_unix: 1770988000,
  });
  assert.equal(badInvoice.ok, false);
  assert.match(badInvoice.error, /invoice invalid/i);
});
