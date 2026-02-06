import test from 'node:test';
import assert from 'node:assert/strict';
import b4a from 'b4a';
import PeerWallet from 'trac-wallet';

import { createUnsignedEnvelope, encodeEnvelopeForSigning, attachSignature } from '../src/protocol/signedMessage.js';
import { hashUnsignedEnvelope } from '../src/swap/hash.js';
import { validateSwapEnvelope } from '../src/swap/schema.js';
import { ASSET, KIND, PAIR } from '../src/swap/constants.js';

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

test('swap schema: terms + accept validate', async () => {
  const receiver = await newWallet();
  const payer = await newWallet();

  const tradeId = 'swap_test_schema_1';
  const nowSec = Math.floor(Date.now() / 1000);

  const termsUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.TERMS,
    tradeId,
    body: {
      pair: PAIR.BTC_LN__USDT_SOL,
      direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
      btc_sats: 12345,
      usdt_amount: '1000000',
      usdt_decimals: 6,
      sol_mint: 'So11111111111111111111111111111111111111112',
      sol_recipient: '11111111111111111111111111111111',
      sol_refund: '11111111111111111111111111111111',
      sol_refund_after_unix: nowSec + 3600,
      ln_receiver_peer: b4a.toString(receiver.publicKey, 'hex'),
      ln_payer_peer: b4a.toString(payer.publicKey, 'hex'),
      terms_valid_until_unix: nowSec + 300,
    },
    ts: Date.now(),
    nonce: 'n1',
  });
  const terms = signEnvelope(receiver, termsUnsigned);
  assert.equal(validateSwapEnvelope(terms).ok, true);

  const acceptUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.ACCEPT,
    tradeId,
    body: { terms_hash: hashUnsignedEnvelope(termsUnsigned) },
    ts: Date.now(),
    nonce: 'n2',
  });
  const accept = signEnvelope(payer, acceptUnsigned);
  assert.equal(validateSwapEnvelope(accept).ok, true);
});

test('swap schema: rfq + quote validate', async () => {
  const nowSec = Math.floor(Date.now() / 1000);

  const rfq = createUnsignedEnvelope({
    v: 1,
    kind: KIND.RFQ,
    tradeId: 'rfq_1',
    body: {
      pair: PAIR.BTC_LN__USDT_SOL,
      direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
      btc_sats: 1000,
      usdt_amount: '1000000',
      valid_until_unix: nowSec + 60,
    },
    ts: Date.now(),
    nonce: 'r1',
  });
  assert.equal(validateSwapEnvelope(rfq).ok, true);
  const rfqId = hashUnsignedEnvelope(rfq);

  const quote = createUnsignedEnvelope({
    v: 1,
    kind: KIND.QUOTE,
    tradeId: 'quote_1',
    body: {
      rfq_id: rfqId,
      pair: PAIR.BTC_LN__USDT_SOL,
      direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
      btc_sats: 1000,
      usdt_amount: '1000000',
      valid_until_unix: nowSec + 30,
    },
    ts: Date.now(),
    nonce: 'q1',
  });
  assert.equal(validateSwapEnvelope(quote).ok, true);

  const quoteMissingExpiry = createUnsignedEnvelope({
    v: 1,
    kind: KIND.QUOTE,
    tradeId: 'quote_2',
    body: {
      rfq_id: rfqId,
      pair: PAIR.BTC_LN__USDT_SOL,
      direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
      btc_sats: 1000,
      usdt_amount: '1000000',
    },
    ts: Date.now(),
    nonce: 'q2',
  });
  assert.equal(validateSwapEnvelope(quoteMissingExpiry).ok, false);
});

test('swap schema: quote_accept + swap_invite validate', async () => {
  const maker = await newWallet();
  const taker = await newWallet();

  const tradeId = 'swap_test_otc_1';
  const nowSec = Math.floor(Date.now() / 1000);

  const rfq = createUnsignedEnvelope({
    v: 1,
    kind: KIND.RFQ,
    tradeId,
    body: {
      pair: PAIR.BTC_LN__USDT_SOL,
      direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
      btc_sats: 1000,
      usdt_amount: '1000000',
      valid_until_unix: nowSec + 60,
    },
    ts: Date.now(),
    nonce: 'r1',
  });
  const rfqId = hashUnsignedEnvelope(rfq);

  const quoteUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.QUOTE,
    tradeId,
    body: {
      rfq_id: rfqId,
      pair: PAIR.BTC_LN__USDT_SOL,
      direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
      btc_sats: 1000,
      usdt_amount: '1000000',
      valid_until_unix: nowSec + 30,
    },
    ts: Date.now(),
    nonce: 'q1',
  });
  const quote = signEnvelope(maker, quoteUnsigned);
  assert.equal(validateSwapEnvelope(quote).ok, true);

  const quoteId = hashUnsignedEnvelope(quoteUnsigned);
  const quoteAcceptUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.QUOTE_ACCEPT,
    tradeId,
    body: {
      rfq_id: rfqId,
      quote_id: quoteId,
    },
    ts: Date.now(),
    nonce: 'qa1',
  });
  const quoteAccept = signEnvelope(taker, quoteAcceptUnsigned);
  assert.equal(validateSwapEnvelope(quoteAccept).ok, true);

  const swapInviteUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.SWAP_INVITE,
    tradeId,
    body: {
      rfq_id: rfqId,
      quote_id: quoteId,
      swap_channel: 'swap:abc123',
      owner_pubkey: b4a.toString(maker.publicKey, 'hex'),
      invite_b64: 'dGVzdA==',
    },
    ts: Date.now(),
    nonce: 'si1',
  });
  const swapInvite = signEnvelope(maker, swapInviteUnsigned);
  assert.equal(validateSwapEnvelope(swapInvite).ok, true);
});
