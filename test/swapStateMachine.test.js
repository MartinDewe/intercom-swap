import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import b4a from 'b4a';
import PeerWallet from 'trac-wallet';

import { createUnsignedEnvelope, encodeEnvelopeForSigning, attachSignature } from '../src/protocol/signedMessage.js';
import { hashUnsignedEnvelope } from '../src/swap/hash.js';
import { applySwapEnvelope, createInitialTrade } from '../src/swap/stateMachine.js';
import { ASSET, KIND, PAIR, STATE } from '../src/swap/constants.js';

async function newWallet() {
  const w = new PeerWallet();
  await w.ready;
  await w.generateKeyPair();
  return w;
}

function signEnvelope(wallet, unsigned) {
  const msg = encodeEnvelopeForSigning(unsigned);
  const sigBuf = wallet.sign(b4a.from(msg, 'utf8'));
  return attachSignature(unsigned, {
    signerPubKeyHex: b4a.toString(wallet.publicKey, 'hex'),
    sigHex: b4a.toString(sigBuf, 'hex'),
  });
}

test('swap state machine: happy path', async () => {
  const receiver = await newWallet();
  const payer = await newWallet();

  const tradeId = 'swap_test_sm_1';
  const nowSec = Math.floor(Date.now() / 1000);
  const paymentHashHex = crypto.randomBytes(32).toString('hex');

  const termsUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.TERMS,
    tradeId,
    body: {
      pair: PAIR.BTC_LN__USDT_SOL,
      direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
      btc_sats: 5000,
      usdt_amount: '2500000',
      usdt_decimals: 6,
      sol_mint: 'So11111111111111111111111111111111111111112',
      sol_recipient: '11111111111111111111111111111111',
      sol_refund: '11111111111111111111111111111111',
      sol_refund_after_unix: nowSec + 3600,
      platform_fee_bps: 50,
      trade_fee_bps: 50,
      trade_fee_collector: '11111111111111111111111111111111',
      ln_receiver_peer: b4a.toString(receiver.publicKey, 'hex'),
      ln_payer_peer: b4a.toString(payer.publicKey, 'hex'),
      terms_valid_until_unix: nowSec + 300,
    },
    ts: Date.now(),
    nonce: 't1',
  });
  const terms = signEnvelope(receiver, termsUnsigned);

  const acceptUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.ACCEPT,
    tradeId,
    body: { terms_hash: hashUnsignedEnvelope(termsUnsigned) },
    ts: Date.now(),
    nonce: 't2',
  });
  const accept = signEnvelope(payer, acceptUnsigned);

  const invoiceUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.LN_INVOICE,
    tradeId,
    body: {
      bolt11: 'lnbcrt1dummyinvoice',
      payment_hash_hex: paymentHashHex,
      amount_msat: String(5000 * 1000),
    },
    ts: Date.now(),
    nonce: 't3',
  });
  const invoice = signEnvelope(receiver, invoiceUnsigned);

  const escrowUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.SOL_ESCROW_CREATED,
    tradeId,
    body: {
      payment_hash_hex: paymentHashHex,
      program_id: '4RS6xpspM1V2K7FKSqeSH6VVaZbtzHzhJqacwrz8gJrF',
      escrow_pda: '11111111111111111111111111111111',
      vault_ata: '11111111111111111111111111111111',
      mint: 'So11111111111111111111111111111111111111112',
      amount: '2500000',
      refund_after_unix: nowSec + 3600,
      recipient: '11111111111111111111111111111111',
      refund: '11111111111111111111111111111111',
      tx_sig: 'dummy_tx_sig_1',
    },
    ts: Date.now(),
    nonce: 't4',
  });
  const escrow = signEnvelope(receiver, escrowUnsigned);

  const lnPaidUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.LN_PAID,
    tradeId,
    body: { payment_hash_hex: paymentHashHex },
    ts: Date.now(),
    nonce: 't5',
  });
  const lnPaid = signEnvelope(payer, lnPaidUnsigned);

  const claimedUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.SOL_CLAIMED,
    tradeId,
    body: { payment_hash_hex: paymentHashHex, escrow_pda: '11111111111111111111111111111111', tx_sig: 'dummy_tx_sig_2' },
    ts: Date.now(),
    nonce: 't6',
  });
  const claimed = signEnvelope(payer, claimedUnsigned);

  let st = createInitialTrade(tradeId);
  let res;

  res = applySwapEnvelope(st, terms);
  assert.equal(res.ok, true, res.error);
  st = res.trade;
  assert.equal(st.state, STATE.TERMS);

  res = applySwapEnvelope(st, accept);
  assert.equal(res.ok, true, res.error);
  st = res.trade;
  assert.equal(st.state, STATE.ACCEPTED);

  res = applySwapEnvelope(st, invoice);
  assert.equal(res.ok, true, res.error);
  st = res.trade;
  assert.equal(st.state, STATE.INVOICE);

  res = applySwapEnvelope(st, escrow);
  assert.equal(res.ok, true, res.error);
  st = res.trade;
  assert.equal(st.state, STATE.ESCROW);

  res = applySwapEnvelope(st, lnPaid);
  assert.equal(res.ok, true, res.error);
  st = res.trade;
  assert.equal(st.state, STATE.LN_PAID);

  res = applySwapEnvelope(st, claimed);
  assert.equal(res.ok, true, res.error);
  st = res.trade;
  assert.equal(st.state, STATE.CLAIMED);
});

test('swap state machine: reject accept with wrong terms_hash', async () => {
  const receiver = await newWallet();
  const payer = await newWallet();
  const tradeId = 'swap_test_sm_2';
  const nowSec = Math.floor(Date.now() / 1000);

  const termsUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.TERMS,
    tradeId,
    body: {
      pair: PAIR.BTC_LN__USDT_SOL,
      direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
      btc_sats: 1,
      usdt_amount: '1',
      sol_mint: 'So11111111111111111111111111111111111111112',
      sol_recipient: '11111111111111111111111111111111',
      sol_refund: '11111111111111111111111111111111',
      sol_refund_after_unix: nowSec + 3600,
      platform_fee_bps: 50,
      trade_fee_bps: 50,
      trade_fee_collector: '11111111111111111111111111111111',
      ln_receiver_peer: b4a.toString(receiver.publicKey, 'hex'),
      ln_payer_peer: b4a.toString(payer.publicKey, 'hex'),
    },
    ts: Date.now(),
    nonce: 'x1',
  });
  const terms = signEnvelope(receiver, termsUnsigned);

  const acceptUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.ACCEPT,
    tradeId,
    body: { terms_hash: 'deadbeef' },
    ts: Date.now(),
    nonce: 'x2',
  });
  const accept = signEnvelope(payer, acceptUnsigned);

  let st = createInitialTrade(tradeId);
  let res = applySwapEnvelope(st, terms);
  assert.equal(res.ok, true, res.error);
  st = res.trade;

  res = applySwapEnvelope(st, accept);
  assert.equal(res.ok, false);
  assert.match(res.error, /terms_hash mismatch/);
});

test('swap state machine: reject invoice from wrong signer', async () => {
  const receiver = await newWallet();
  const payer = await newWallet();
  const tradeId = 'swap_test_sm_3';
  const nowSec = Math.floor(Date.now() / 1000);

  const termsUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.TERMS,
    tradeId,
    body: {
      pair: PAIR.BTC_LN__USDT_SOL,
      direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
      btc_sats: 1,
      usdt_amount: '1',
      sol_mint: 'So11111111111111111111111111111111111111112',
      sol_recipient: '11111111111111111111111111111111',
      sol_refund: '11111111111111111111111111111111',
      sol_refund_after_unix: nowSec + 3600,
      platform_fee_bps: 50,
      trade_fee_bps: 50,
      trade_fee_collector: '11111111111111111111111111111111',
      ln_receiver_peer: b4a.toString(receiver.publicKey, 'hex'),
      ln_payer_peer: b4a.toString(payer.publicKey, 'hex'),
    },
    ts: Date.now(),
    nonce: 'y1',
  });
  const terms = signEnvelope(receiver, termsUnsigned);

  const acceptUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.ACCEPT,
    tradeId,
    body: { terms_hash: hashUnsignedEnvelope(termsUnsigned) },
    ts: Date.now(),
    nonce: 'y2',
  });
  const accept = signEnvelope(payer, acceptUnsigned);

  const invoiceUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.LN_INVOICE,
    tradeId,
    body: { bolt11: 'lnbcrt1dummy', payment_hash_hex: crypto.randomBytes(32).toString('hex') },
    ts: Date.now(),
    nonce: 'y3',
  });
  const invoiceWrongSigner = signEnvelope(payer, invoiceUnsigned);

  let st = createInitialTrade(tradeId);
  let res = applySwapEnvelope(st, terms);
  assert.equal(res.ok, true, res.error);
  st = res.trade;
  res = applySwapEnvelope(st, accept);
  assert.equal(res.ok, true, res.error);
  st = res.trade;

  res = applySwapEnvelope(st, invoiceWrongSigner);
  assert.equal(res.ok, false);
  assert.match(res.error, /wrong signer/);
});

test('swap state machine: reject accept after terms_valid_until_unix', async () => {
  const receiver = await newWallet();
  const payer = await newWallet();

  const tradeId = 'swap_test_sm_timeout_1';
  const nowSec = Math.floor(Date.now() / 1000);

  const termsUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.TERMS,
    tradeId,
    body: {
      pair: PAIR.BTC_LN__USDT_SOL,
      direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
      btc_sats: 100,
      usdt_amount: '1',
      sol_mint: 'So11111111111111111111111111111111111111112',
      sol_recipient: '11111111111111111111111111111111',
      sol_refund: '11111111111111111111111111111111',
      sol_refund_after_unix: nowSec + 3600,
      platform_fee_bps: 50,
      trade_fee_bps: 50,
      trade_fee_collector: '11111111111111111111111111111111',
      ln_receiver_peer: b4a.toString(receiver.publicKey, 'hex'),
      ln_payer_peer: b4a.toString(payer.publicKey, 'hex'),
      terms_valid_until_unix: nowSec - 5,
    },
    ts: Date.now(),
    nonce: 'z1',
  });
  const terms = signEnvelope(receiver, termsUnsigned);

  const acceptUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.ACCEPT,
    tradeId,
    body: { terms_hash: hashUnsignedEnvelope(termsUnsigned) },
    ts: (nowSec - 4) * 1000,
    nonce: 'z2',
  });
  const accept = signEnvelope(payer, acceptUnsigned);

  let st = createInitialTrade(tradeId);
  let res = applySwapEnvelope(st, terms);
  assert.equal(res.ok, true, res.error);
  st = res.trade;

  res = applySwapEnvelope(st, accept);
  assert.equal(res.ok, false);
  assert.match(res.error, /terms expiry/i);
});

test('swap state machine: accept idempotent replay after accepted', async () => {
  const receiver = await newWallet();
  const payer = await newWallet();

  const tradeId = 'swap_test_sm_idem_1';
  const nowSec = Math.floor(Date.now() / 1000);

  const termsUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.TERMS,
    tradeId,
    body: {
      pair: PAIR.BTC_LN__USDT_SOL,
      direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
      btc_sats: 10,
      usdt_amount: '1',
      sol_mint: 'So11111111111111111111111111111111111111112',
      sol_recipient: '11111111111111111111111111111111',
      sol_refund: '11111111111111111111111111111111',
      sol_refund_after_unix: nowSec + 3600,
      platform_fee_bps: 50,
      trade_fee_bps: 50,
      trade_fee_collector: '11111111111111111111111111111111',
      ln_receiver_peer: b4a.toString(receiver.publicKey, 'hex'),
      ln_payer_peer: b4a.toString(payer.publicKey, 'hex'),
      terms_valid_until_unix: nowSec + 300,
    },
    ts: Date.now(),
    nonce: 'i1',
  });
  const terms = signEnvelope(receiver, termsUnsigned);

  const acceptUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.ACCEPT,
    tradeId,
    body: { terms_hash: hashUnsignedEnvelope(termsUnsigned) },
    ts: Date.now(),
    nonce: 'i2',
  });
  const accept = signEnvelope(payer, acceptUnsigned);

  let st = createInitialTrade(tradeId);
  let res = applySwapEnvelope(st, terms);
  assert.equal(res.ok, true, res.error);
  st = res.trade;

  res = applySwapEnvelope(st, accept);
  assert.equal(res.ok, true, res.error);
  st = res.trade;
  assert.equal(st.state, STATE.ACCEPTED);
  const acceptedAt = st.accepted_at;

  // Replay same accept.
  res = applySwapEnvelope(st, accept);
  assert.equal(res.ok, true, res.error);
  st = res.trade;
  assert.equal(st.state, STATE.ACCEPTED);
  assert.equal(st.accepted_at, acceptedAt);
});

test('swap state machine: reject escrow refund_after earlier than terms', async () => {
  const receiver = await newWallet();
  const payer = await newWallet();

  const tradeId = 'swap_test_sm_timeout_2';
  const nowSec = Math.floor(Date.now() / 1000);
  const paymentHashHex = crypto.randomBytes(32).toString('hex');

  const termsUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.TERMS,
    tradeId,
    body: {
      pair: PAIR.BTC_LN__USDT_SOL,
      direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
      btc_sats: 1,
      usdt_amount: '1',
      sol_mint: 'So11111111111111111111111111111111111111112',
      sol_recipient: '11111111111111111111111111111111',
      sol_refund: '11111111111111111111111111111111',
      sol_refund_after_unix: nowSec + 3600,
      platform_fee_bps: 50,
      trade_fee_bps: 50,
      trade_fee_collector: '11111111111111111111111111111111',
      ln_receiver_peer: b4a.toString(receiver.publicKey, 'hex'),
      ln_payer_peer: b4a.toString(payer.publicKey, 'hex'),
    },
    ts: Date.now(),
    nonce: 'r1',
  });
  const terms = signEnvelope(receiver, termsUnsigned);

  const acceptUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.ACCEPT,
    tradeId,
    body: { terms_hash: hashUnsignedEnvelope(termsUnsigned) },
    ts: Date.now(),
    nonce: 'r2',
  });
  const accept = signEnvelope(payer, acceptUnsigned);

  const invoiceUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.LN_INVOICE,
    tradeId,
    body: { bolt11: 'lnbcrt1dummy', payment_hash_hex: paymentHashHex },
    ts: Date.now(),
    nonce: 'r3',
  });
  const invoice = signEnvelope(receiver, invoiceUnsigned);

  const escrowUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.SOL_ESCROW_CREATED,
    tradeId,
    body: {
      payment_hash_hex: paymentHashHex,
      program_id: '4RS6xpspM1V2K7FKSqeSH6VVaZbtzHzhJqacwrz8gJrF',
      escrow_pda: '11111111111111111111111111111111',
      vault_ata: '11111111111111111111111111111111',
      mint: 'So11111111111111111111111111111111111111112',
      amount: '1',
      refund_after_unix: nowSec + 10,
      recipient: '11111111111111111111111111111111',
      refund: '11111111111111111111111111111111',
      tx_sig: 'dummy_tx_sig_1',
    },
    ts: Date.now(),
    nonce: 'r4',
  });
  const escrow = signEnvelope(receiver, escrowUnsigned);

  let st = createInitialTrade(tradeId);
  let res = applySwapEnvelope(st, terms);
  assert.equal(res.ok, true, res.error);
  st = res.trade;

  res = applySwapEnvelope(st, accept);
  assert.equal(res.ok, true, res.error);
  st = res.trade;

  res = applySwapEnvelope(st, invoice);
  assert.equal(res.ok, true, res.error);
  st = res.trade;

  res = applySwapEnvelope(st, escrow);
  assert.equal(res.ok, false);
  assert.match(res.error, /refund_after_unix/i);
});

test('swap state machine: reject escrow payment_hash mismatch vs invoice', async () => {
  const receiver = await newWallet();
  const payer = await newWallet();

  const tradeId = 'swap_test_sm_timeout_3';
  const nowSec = Math.floor(Date.now() / 1000);
  const paymentHashA = crypto.randomBytes(32).toString('hex');
  const paymentHashB = crypto.randomBytes(32).toString('hex');

  const termsUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.TERMS,
    tradeId,
    body: {
      pair: PAIR.BTC_LN__USDT_SOL,
      direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
      btc_sats: 1,
      usdt_amount: '1',
      sol_mint: 'So11111111111111111111111111111111111111112',
      sol_recipient: '11111111111111111111111111111111',
      sol_refund: '11111111111111111111111111111111',
      sol_refund_after_unix: nowSec + 3600,
      platform_fee_bps: 50,
      trade_fee_bps: 50,
      trade_fee_collector: '11111111111111111111111111111111',
      ln_receiver_peer: b4a.toString(receiver.publicKey, 'hex'),
      ln_payer_peer: b4a.toString(payer.publicKey, 'hex'),
    },
    ts: Date.now(),
    nonce: 'h1',
  });
  const terms = signEnvelope(receiver, termsUnsigned);

  const acceptUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.ACCEPT,
    tradeId,
    body: { terms_hash: hashUnsignedEnvelope(termsUnsigned) },
    ts: Date.now(),
    nonce: 'h2',
  });
  const accept = signEnvelope(payer, acceptUnsigned);

  const invoiceUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.LN_INVOICE,
    tradeId,
    body: { bolt11: 'lnbcrt1dummy', payment_hash_hex: paymentHashA },
    ts: Date.now(),
    nonce: 'h3',
  });
  const invoice = signEnvelope(receiver, invoiceUnsigned);

  const escrowUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.SOL_ESCROW_CREATED,
    tradeId,
    body: {
      payment_hash_hex: paymentHashB,
      program_id: '4RS6xpspM1V2K7FKSqeSH6VVaZbtzHzhJqacwrz8gJrF',
      escrow_pda: '11111111111111111111111111111111',
      vault_ata: '11111111111111111111111111111111',
      mint: 'So11111111111111111111111111111111111111112',
      amount: '1',
      refund_after_unix: nowSec + 3600,
      recipient: '11111111111111111111111111111111',
      refund: '11111111111111111111111111111111',
      tx_sig: 'dummy_tx_sig_1',
    },
    ts: Date.now(),
    nonce: 'h4',
  });
  const escrow = signEnvelope(receiver, escrowUnsigned);

  let st = createInitialTrade(tradeId);
  let res = applySwapEnvelope(st, terms);
  assert.equal(res.ok, true, res.error);
  st = res.trade;

  res = applySwapEnvelope(st, accept);
  assert.equal(res.ok, true, res.error);
  st = res.trade;

  res = applySwapEnvelope(st, invoice);
  assert.equal(res.ok, true, res.error);
  st = res.trade;

  res = applySwapEnvelope(st, escrow);
  assert.equal(res.ok, false);
  assert.match(res.error, /payment_hash mismatch/i);
});

test('swap state machine: invoice idempotent replay in escrow state', async () => {
  const receiver = await newWallet();
  const payer = await newWallet();

  const tradeId = 'swap_test_sm_idem_2';
  const nowSec = Math.floor(Date.now() / 1000);
  const paymentHashHex = crypto.randomBytes(32).toString('hex');

  const termsUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.TERMS,
    tradeId,
    body: {
      pair: PAIR.BTC_LN__USDT_SOL,
      direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
      btc_sats: 1,
      usdt_amount: '1',
      sol_mint: 'So11111111111111111111111111111111111111112',
      sol_recipient: '11111111111111111111111111111111',
      sol_refund: '11111111111111111111111111111111',
      sol_refund_after_unix: nowSec + 3600,
      platform_fee_bps: 50,
      trade_fee_bps: 50,
      trade_fee_collector: '11111111111111111111111111111111',
      ln_receiver_peer: b4a.toString(receiver.publicKey, 'hex'),
      ln_payer_peer: b4a.toString(payer.publicKey, 'hex'),
    },
    ts: Date.now(),
    nonce: 'ii1',
  });
  const terms = signEnvelope(receiver, termsUnsigned);

  const acceptUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.ACCEPT,
    tradeId,
    body: { terms_hash: hashUnsignedEnvelope(termsUnsigned) },
    ts: Date.now(),
    nonce: 'ii2',
  });
  const accept = signEnvelope(payer, acceptUnsigned);

  const invoiceUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.LN_INVOICE,
    tradeId,
    body: { bolt11: 'lnbcrt1dummy', payment_hash_hex: paymentHashHex },
    ts: Date.now(),
    nonce: 'ii3',
  });
  const invoice = signEnvelope(receiver, invoiceUnsigned);

  const escrowUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.SOL_ESCROW_CREATED,
    tradeId,
    body: {
      payment_hash_hex: paymentHashHex,
      program_id: '4RS6xpspM1V2K7FKSqeSH6VVaZbtzHzhJqacwrz8gJrF',
      escrow_pda: '11111111111111111111111111111111',
      vault_ata: '11111111111111111111111111111111',
      mint: 'So11111111111111111111111111111111111111112',
      amount: '1',
      refund_after_unix: nowSec + 3600,
      recipient: '11111111111111111111111111111111',
      refund: '11111111111111111111111111111111',
      tx_sig: 'dummy_tx_sig_1',
    },
    ts: Date.now(),
    nonce: 'ii4',
  });
  const escrow = signEnvelope(receiver, escrowUnsigned);

  let st = createInitialTrade(tradeId);
  let res = applySwapEnvelope(st, terms);
  assert.equal(res.ok, true, res.error);
  st = res.trade;

  res = applySwapEnvelope(st, accept);
  assert.equal(res.ok, true, res.error);
  st = res.trade;

  res = applySwapEnvelope(st, invoice);
  assert.equal(res.ok, true, res.error);
  st = res.trade;

  res = applySwapEnvelope(st, escrow);
  assert.equal(res.ok, true, res.error);
  st = res.trade;
  assert.equal(st.state, STATE.ESCROW);

  // Replay invoice; should be a no-op.
  res = applySwapEnvelope(st, invoice);
  assert.equal(res.ok, true, res.error);
  st = res.trade;
  assert.equal(st.state, STATE.ESCROW);
});

test('swap state machine: reject terms update after accept', async () => {
  const receiver = await newWallet();
  const payer = await newWallet();

  const tradeId = 'swap_test_sm_terms_lock_1';
  const nowSec = Math.floor(Date.now() / 1000);

  const termsUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.TERMS,
    tradeId,
    body: {
      pair: PAIR.BTC_LN__USDT_SOL,
      direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
      btc_sats: 1,
      usdt_amount: '1',
      sol_mint: 'So11111111111111111111111111111111111111112',
      sol_recipient: '11111111111111111111111111111111',
      sol_refund: '11111111111111111111111111111111',
      sol_refund_after_unix: nowSec + 3600,
      platform_fee_bps: 50,
      trade_fee_bps: 50,
      trade_fee_collector: '11111111111111111111111111111111',
      ln_receiver_peer: b4a.toString(receiver.publicKey, 'hex'),
      ln_payer_peer: b4a.toString(payer.publicKey, 'hex'),
    },
    ts: Date.now(),
    nonce: 'lk1',
  });
  const terms = signEnvelope(receiver, termsUnsigned);

  const acceptUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.ACCEPT,
    tradeId,
    body: { terms_hash: hashUnsignedEnvelope(termsUnsigned) },
    ts: Date.now(),
    nonce: 'lk2',
  });
  const accept = signEnvelope(payer, acceptUnsigned);

  const terms2Unsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.TERMS,
    tradeId,
    body: {
      ...termsUnsigned.body,
      usdt_amount: '2',
    },
    ts: Date.now(),
    nonce: 'lk3',
  });
  const terms2 = signEnvelope(receiver, terms2Unsigned);

  let st = createInitialTrade(tradeId);
  let res = applySwapEnvelope(st, terms);
  assert.equal(res.ok, true, res.error);
  st = res.trade;

  res = applySwapEnvelope(st, accept);
  assert.equal(res.ok, true, res.error);
  st = res.trade;
  assert.equal(st.state, STATE.ACCEPTED);

  // Same terms can be replayed.
  res = applySwapEnvelope(st, terms);
  assert.equal(res.ok, true, res.error);

  // Updated terms should be rejected after accept.
  res = applySwapEnvelope(st, terms2);
  assert.equal(res.ok, false);
  assert.match(res.error, /not allowed/i);
});
