import test from 'node:test';
import assert from 'node:assert/strict';

import { repairToolArguments } from '../src/prompt/repair.js';

test('repairToolArguments: coerces offer_post usdt_amount decimal to atomic', () => {
  const out = repairToolArguments('intercomswap_offer_post', {
    channels: ['0000intercomswapbtcusdt'],
    name: 'maker:alice',
    offers: [
      {
        pair: 'BTC_LN/USDT_SOL',
        have: 'USDT_SOL',
        want: 'BTC_LN',
        btc_sats: 1000,
        usdt_amount: '0.12',
        max_platform_fee_bps: 10,
        max_trade_fee_bps: 10,
        max_total_fee_bps: 20,
        min_sol_refund_window_sec: 3600,
        max_sol_refund_window_sec: 7200,
      },
    ],
  });
  assert.equal(out.offers[0].usdt_amount, '120000');
});

test('repairToolArguments: coerces flattened offer_post usdt_amount decimal to atomic', () => {
  const out = repairToolArguments('intercomswap_offer_post', {
    channels: ['0000intercomswapbtcusdt'],
    name: 'maker:alice',
    pair: 'BTC_LN/USDT_SOL',
    have: 'USDT_SOL',
    want: 'BTC_LN',
    btc_sats: 1000,
    usdt_amount: '0.12',
    max_platform_fee_bps: 10,
    max_trade_fee_bps: 10,
    max_total_fee_bps: 20,
    min_sol_refund_window_sec: 3600,
    max_sol_refund_window_sec: 7200,
  });
  assert.ok(Array.isArray(out.offers));
  assert.equal(out.offers.length, 1);
  assert.equal(out.offers[0].usdt_amount, '120000');
  assert.ok(!('usdt_amount' in out)); // flattened key removed
});

test('repairToolArguments: coerces rfq_post usdt_amount decimal to atomic', () => {
  const out = repairToolArguments('intercomswap_rfq_post', {
    channel: '0000intercomswapbtcusdt',
    trade_id: 'rfq-1',
    btc_sats: 1000,
    usdt_amount: '0.12',
  });
  assert.equal(out.usdt_amount, '120000');
});

test('repairToolArguments: rfq_post accepts ttl_sec by converting to valid_until_unix', () => {
  const out = repairToolArguments('intercomswap_rfq_post', {
    channel: '0000intercomswapbtcusdt',
    trade_id: 'rfq-1',
    btc_sats: 1000,
    usdt_amount: '120000',
    ttl_sec: 60,
  });
  assert.ok('valid_until_unix' in out);
  assert.ok(!('ttl_sec' in out));
});

test('repairToolArguments: offer_post drops valid_until_unix when ttl_sec is present', () => {
  const out = repairToolArguments('intercomswap_offer_post', {
    channels: ['0000intercomswapbtcusdt'],
    name: 'maker:alice',
    ttl_sec: 86400,
    valid_until_unix: 9999999999,
    offers: [
      {
        pair: 'BTC_LN/USDT_SOL',
        have: 'USDT_SOL',
        want: 'BTC_LN',
        btc_sats: 1000,
        usdt_amount: '120000',
        max_platform_fee_bps: 10,
        max_trade_fee_bps: 10,
        max_total_fee_bps: 20,
        min_sol_refund_window_sec: 3600,
        max_sol_refund_window_sec: 7200,
      },
    ],
  });
  assert.ok('ttl_sec' in out);
  assert.ok(!('valid_until_unix' in out));
});

test('repairToolArguments: offer_post renames common offer-line key aliases', () => {
  const out = repairToolArguments('intercomswap_offer_post', {
    channels: ['0000intercomswapbtcusdt'],
    name: 'maker:alice',
    offers: [
      {
        pair: 'BTC_LN/USDT_SOL',
        have: 'USDT_SOL',
        want: 'BTC_LN',
        btc_sats: 1000,
        usdt_amount: '0.12',
        max_platform_fee_bps: 10,
        max_trade_fee_b: 10,
        max_total_fee_bps: 20,
        min_sol_refund_window_sec: 3600,
        max_sol_refund_sec: 7200,
      },
    ],
  });
  assert.equal(out.offers[0].usdt_amount, '120000');
  assert.ok(!('max_trade_fee_b' in out.offers[0]));
  assert.equal(out.offers[0].max_trade_fee_bps, 10);
  assert.ok(!('max_sol_refund_sec' in out.offers[0]));
  assert.equal(out.offers[0].max_sol_refund_window_sec, 7200);
});

test('repairToolArguments: quote_post maps ttl_sec to valid_for_sec', () => {
  const out = repairToolArguments('intercomswap_quote_post', {
    channel: '0000intercomswapbtcusdt',
    trade_id: 'rfq-1',
    rfq_id: '0'.repeat(64),
    btc_sats: 1000,
    usdt_amount: '120000',
    trade_fee_collector: '11111111111111111111111111111111',
    ttl_sec: 60,
  });
  assert.equal(out.valid_for_sec, 60);
  assert.ok(!('ttl_sec' in out));
});

test('repairToolArguments: coerces sol_transfer_sol lamports decimal (SOL units) to atomic lamports', () => {
  const out = repairToolArguments('intercomswap_sol_transfer_sol', {
    to: '11111111111111111111111111111111',
    lamports: '0.01',
  });
  assert.equal(out.lamports, '10000000');
});

test('repairToolArguments: autopost_start rewrites amount-derived job names to Collin-style names', () => {
  const out = repairToolArguments('intercomswap_autopost_start', {
    name: 'offer_1000sats_0.12usdt',
    tool: 'intercomswap_offer_post',
    interval_sec: '10',
    ttl_sec: '60',
    args: {
      channels: ['0000intercomswapbtcusdt'],
      name: 'maker:alice',
      offers: [{ btc_sats: 1000, usdt_amount: '120000' }],
    },
  });
  assert.equal(out.interval_sec, 10);
  assert.equal(out.ttl_sec, 60);
  assert.ok(typeof out.name === 'string' && out.name.length > 0);
  assert.ok(out.name.startsWith('offer_maker_alice_'), out.name);
  assert.ok(!out.name.includes('sats'), out.name);
  assert.ok(!out.name.includes('usdt'), out.name);
});

test('repairToolArguments: autopost_start renames arguments -> args (nested sub-tool args)', () => {
  const out = repairToolArguments('intercomswap_autopost_start', {
    name: 'rfq_job',
    tool: 'intercomswap_rfq_post',
    interval_sec: 10,
    ttl_sec: 60,
    arguments: { channel: 'c', trade_id: 'rfq-1', btc_sats: 1002, usdt_amount: '0.33' },
  });
  assert.ok(!('arguments' in out));
  assert.ok(out.args && typeof out.args === 'object');
  assert.equal(out.args.btc_sats, 1002);
});
