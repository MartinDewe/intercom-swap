#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';

import { ScBridgeClient } from '../src/sc-bridge/client.js';
import { createUnsignedEnvelope, attachSignature } from '../src/protocol/signedMessage.js';
import { validateSwapEnvelope } from '../src/swap/schema.js';
import { KIND, ASSET, PAIR } from '../src/swap/constants.js';
import { hashUnsignedEnvelope } from '../src/swap/hash.js';
import { hashTermsEnvelope } from '../src/swap/terms.js';
import { verifySwapPrePay, verifySwapPrePayOnchain } from '../src/swap/verify.js';
import {
  createSignedInvite,
  normalizeInvitePayload,
  normalizeWelcomePayload,
  toB64Json,
} from '../src/sidechannel/capabilities.js';
import { SolanaRpcPool } from '../src/solana/rpcPool.js';

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function usage() {
  return `
swapctl (SC-Bridge sidechannel + swap message helper)

Connection flags (required for SC-Bridge commands):
  --url <ws://127.0.0.1:49222>
  --token <sc-bridge-token>

Commands:
  info
  stats
  price-get
  watch [--channels <a,b,c>] [--kinds <k1,k2>] [--trade-id <id>] [--pretty 0|1] [--raw 0|1]
  join --channel <name> [--invite <b64|json|@file>] [--welcome <b64|json|@file>]
  leave --channel <name>
  open --channel <name> --via <entryChannel> [--invite ...] [--welcome ...]
  send --channel <name> (--text <msg> | --json <obj|@file>)

Service/presence announcements (signed swap envelopes):
  svc-announce --channels <a,b,c> --name <label> [--pairs <p1,p2>] [--otc-channels <a,b,c>] [--note <text>] [--offers-json <json|@file>] [--trade-id <id>] [--ttl-sec <sec>] [--join 0|1]
  svc-announce-loop --channels <a,b,c> --config <json|@file> [--interval-sec <sec>] [--watch 0|1] [--ttl-sec <sec>] [--trade-id <id>] [--join 0|1]

Invite/Welcome helpers (signed by the peer via SC-Bridge sign):
  make-welcome --channel <name> --text <welcomeText>
  make-invite --channel <name> --invitee-pubkey <hex32> [--ttl-sec <sec>] [--welcome <b64|json|@file>]

Swap message helpers (signed swap envelopes, sent over sidechannels):
  rfq --channel <otcChannel> --trade-id <id> --btc-sats <n> --usdt-amount <atomicStr> [--valid-until-unix <sec>]
  quote --channel <otcChannel> --trade-id <id> --rfq-id <id> --btc-sats <n> --usdt-amount <atomicStr> --valid-until-unix <sec>
  quote-from-rfq --channel <otcChannel> --rfq-json <envelope|@file> [--btc-sats <n>] [--usdt-amount <atomicStr>] [--valid-until-unix <sec>]
  quote-accept --channel <otcChannel> --quote-json <envelope|@file>
  swap-invite-from-accept --channel <otcChannel> --accept-json <envelope|@file> [--swap-channel <name>] [--welcome-text <text>] [--ttl-sec <sec>]
  join-from-swap-invite --swap-invite-json <envelope|@file>
  terms --channel <swapChannel> --trade-id <id> --btc-sats <n> --usdt-amount <atomicStr> --sol-mint <base58> --sol-recipient <base58> --sol-refund <base58> --sol-refund-after-unix <sec> --ln-receiver-peer <hex32> --ln-payer-peer <hex32> --platform-fee-bps <n> --trade-fee-bps <n> --trade-fee-collector <base58> [--platform-fee-collector <base58>] [--terms-valid-until-unix <sec>]
  accept --channel <swapChannel> --trade-id <id> (--terms-hash <hex> | --terms-json <envelope|@file>)

Verification helpers:
  verify-prepay --terms-json <envelope|body|@file> --invoice-json <envelope|body|@file> --escrow-json <envelope|body|@file> [--now-unix <sec>] [--solana-rpc-url <url[,url2,...]>] [--solana-commitment <confirmed|finalized|processed>]

Notes:
  - This tool never touches private keys; it asks the peer to sign via SC-Bridge.
  - For protected channels, pass the invite/welcome when joining/sending as needed.
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

function splitCsv(value) {
  if (value === undefined || value === null) return [];
  const s = String(value).trim();
  if (!s) return [];
  return s
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function parseBoolFlag(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (value === true) return true;
  const s = String(value).trim().toLowerCase();
  if (!s) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(s);
}

function readTextMaybeFile(value) {
  if (typeof value !== 'string') return '';
  const v = value.trim();
  if (!v) return '';
  if (v.startsWith('@')) {
    const p = v.slice(1);
    return fs.readFileSync(p, 'utf8');
  }
  return v;
}

function parseJsonMaybeFile(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Inline JSON.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch (_e) {
      return null;
    }
  }

  // @file convention.
  if (trimmed.startsWith('@')) {
    try {
      const p = trimmed.slice(1);
      const text = fs.readFileSync(p, 'utf8');
      return JSON.parse(String(text || '').trim());
    } catch (_e) {
      return null;
    }
  }

  // Plain file path.
  try {
    if (fs.existsSync(trimmed)) {
      const text = fs.readFileSync(trimmed, 'utf8');
      return JSON.parse(String(text || '').trim());
    }
  } catch (_e) {}

  return null;
}

function parseJsonOrBase64(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const raw = readTextMaybeFile(value);
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith('{')) {
    try {
      return JSON.parse(text);
    } catch (_e) {
      return null;
    }
  }
  try {
    const decoded = Buffer.from(text, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch (_e) {}
  return null;
}

function requireFlag(flags, name) {
  const v = flags.get(name);
  if (!v || v === true) die(`Missing --${name}`);
  return String(v);
}

function maybeInt(value, label) {
  if (value === undefined || value === null) return null;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) die(`Invalid ${label}`);
  return n;
}

function extractBody(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return payload.body && typeof payload.body === 'object' ? payload.body : payload;
}

async function withScBridge({ url, token }, fn) {
  const sc = new ScBridgeClient({ url, token });
  try {
    await sc.connect();
    return await fn(sc);
  } finally {
    sc.close();
  }
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

function stripSignature(envelope) {
  if (!envelope || typeof envelope !== 'object') return envelope;
  const { sig: _sig, signer: _signer, ...unsigned } = envelope;
  return unsigned;
}

async function main() {
  const { args, flags } = parseArgs(process.argv.slice(2));
  const cmd = args[0] || '';

  if (!cmd || cmd === '--help' || cmd === 'help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (cmd === 'verify-prepay') {
    const termsRaw = parseJsonOrBase64(requireFlag(flags, 'terms-json'));
    const invoiceRaw = parseJsonOrBase64(requireFlag(flags, 'invoice-json'));
    const escrowRaw = parseJsonOrBase64(requireFlag(flags, 'escrow-json'));
    if (!termsRaw) die('Invalid --terms-json (expected JSON/base64/@file)');
    if (!invoiceRaw) die('Invalid --invoice-json (expected JSON/base64/@file)');
    if (!escrowRaw) die('Invalid --escrow-json (expected JSON/base64/@file)');

    const terms = extractBody(termsRaw);
    const invoiceBody = extractBody(invoiceRaw);
    const escrowBody = extractBody(escrowRaw);
    const nowUnix = maybeInt(flags.get('now-unix'), 'now-unix');

    const rpcUrlRaw = flags.get('solana-rpc-url') ? String(flags.get('solana-rpc-url')).trim() : '';
    const commitmentRaw = flags.get('solana-commitment')
      ? String(flags.get('solana-commitment')).trim()
      : 'confirmed';

    if (rpcUrlRaw) {
      const pool = new SolanaRpcPool({ rpcUrls: rpcUrlRaw, commitment: commitmentRaw });
      const res = await pool.call(
        async (connection) =>
          await verifySwapPrePayOnchain({
            terms,
            invoiceBody,
            escrowBody,
            connection,
            commitment: commitmentRaw,
            now_unix: nowUnix,
          }),
        { label: 'verify-prepay' }
      );
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      return;
    }

    const res = verifySwapPrePay({ terms, invoiceBody, escrowBody, now_unix: nowUnix });
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }

  const url = requireFlag(flags, 'url');
  const token = requireFlag(flags, 'token');

  if (cmd === 'info') {
    const res = await withScBridge({ url, token }, (sc) => sc.info());
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }

  if (cmd === 'stats') {
    const res = await withScBridge({ url, token }, (sc) => sc.stats());
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }

  if (cmd === 'price-get') {
    const res = await withScBridge({ url, token }, (sc) => sc.priceGet());
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }

  if (cmd === 'watch') {
    const channels = splitCsv(flags.get('channels') || flags.get('channel'));
    const kinds = new Set(splitCsv(flags.get('kinds') || flags.get('kind')));
    const tradeId = flags.get('trade-id') ? String(flags.get('trade-id')) : null;
    const pretty = parseBoolFlag(flags.get('pretty'), false);
    const raw = parseBoolFlag(flags.get('raw'), false);

    const sc = new ScBridgeClient({ url, token });
    await sc.connect();
    try {
      if (channels.length > 0) {
        await sc.subscribe(channels);
      }
      sc.on('sidechannel_message', (evt) => {
        const msg = evt?.message;
        if (kinds.size > 0) {
          const k = msg && typeof msg === 'object' ? msg.kind : null;
          if (!k || !kinds.has(String(k))) return;
        }
        if (tradeId) {
          const tid = msg && typeof msg === 'object' ? msg.trade_id : null;
          if (String(tid || '') !== tradeId) return;
        }

        const out = raw
          ? evt
          : {
              channel: evt?.channel ?? null,
              from: evt?.from ?? null,
              origin: evt?.origin ?? null,
              relayedBy: evt?.relayedBy ?? null,
              ts: evt?.ts ?? null,
              message: msg,
            };

        if (pretty) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
        else process.stdout.write(`${JSON.stringify(out)}\n`);
      });

      await new Promise((resolve) => {
        process.on('SIGINT', resolve);
        process.on('SIGTERM', resolve);
      });
    } finally {
      sc.close();
    }
    return;
  }

  if (cmd === 'join') {
    const channel = requireFlag(flags, 'channel');
    const invite = parseJsonOrBase64(flags.get('invite'));
    const welcome = parseJsonOrBase64(flags.get('welcome'));
    const res = await withScBridge({ url, token }, (sc) => sc.join(channel, { invite, welcome }));
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }

  if (cmd === 'leave') {
    const channel = requireFlag(flags, 'channel');
    const res = await withScBridge({ url, token }, (sc) => sc.leave(channel));
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }

  if (cmd === 'open') {
    const channel = requireFlag(flags, 'channel');
    const via = requireFlag(flags, 'via');
    const invite = parseJsonOrBase64(flags.get('invite'));
    const welcome = parseJsonOrBase64(flags.get('welcome'));
    const res = await withScBridge({ url, token }, (sc) => sc.open(channel, { via, invite, welcome }));
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }

  if (cmd === 'send') {
    const channel = requireFlag(flags, 'channel');
    const invite = parseJsonOrBase64(flags.get('invite'));
    const welcome = parseJsonOrBase64(flags.get('welcome'));
    const text = flags.get('text');
    const json = flags.get('json');
    if (!text && !json) die('send requires --text or --json');
    if (text && json) die('send requires exactly one of --text or --json');
    const message = text ? String(text) : JSON.parse(readTextMaybeFile(String(json)));
    const res = await withScBridge({ url, token }, (sc) => sc.send(channel, message, { invite, welcome }));
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }

  if (cmd === 'make-welcome') {
    const channel = requireFlag(flags, 'channel');
    const text = requireFlag(flags, 'text');
    const welcome = await withScBridge({ url, token }, async (sc) => {
      const { signerHex: ownerPubKey } = await signViaBridge(sc, { _probe: 'welcome_owner' });
      const payload = normalizeWelcomePayload({ channel, ownerPubKey, text, issuedAt: Date.now(), version: 1 });
      const { sigHex } = await signViaBridge(sc, payload);
      return { payload, sig: sigHex };
    });
    process.stdout.write(`${JSON.stringify(welcome, null, 2)}\n`);
    process.stdout.write(`welcome_b64=${toB64Json(welcome)}\n`);
    return;
  }

  if (cmd === 'make-invite') {
    const channel = requireFlag(flags, 'channel');
    const inviteePubKey = requireFlag(flags, 'invitee-pubkey').toLowerCase();
    const ttlSec = maybeInt(flags.get('ttl-sec'), 'ttl-sec');
    const welcome = parseJsonOrBase64(flags.get('welcome'));
    const invite = await withScBridge({ url, token }, async (sc) => {
      // Determine inviter pubkey from signer.
      const { signerHex: inviterPubKey } = await signViaBridge(sc, { _probe: 'inviter_pubkey' });
      const issuedAt = Date.now();
      const ttlMs = ttlSec !== null ? ttlSec * 1000 : 7 * 24 * 3600 * 1000;
      const payload = normalizeInvitePayload({
        channel,
        inviteePubKey,
        inviterPubKey,
        inviterAddress: null,
        issuedAt,
        expiresAt: issuedAt + ttlMs,
        nonce: Math.random().toString(36).slice(2, 10),
        version: 1,
      });
      const { sigHex } = await signViaBridge(sc, payload);
      return createSignedInvite(payload, () => sigHex, { welcome: welcome || null });
    });
    process.stdout.write(`${JSON.stringify(invite, null, 2)}\n`);
    process.stdout.write(`invite_b64=${toB64Json(invite)}\n`);
    return;
  }

  const sendSigned = async (channel, signedEnvelope, { invite = null, welcome = null } = {}) => {
    const res = await withScBridge({ url, token }, (sc) => sc.send(channel, signedEnvelope, { invite, welcome }));
    if (res.type !== 'sent') throw new Error(`send failed: ${JSON.stringify(res).slice(0, 200)}`);
    return res;
  };

  if (cmd === 'svc-announce') {
    const channels = splitCsv(flags.get('channels') || flags.get('channel'));
    if (channels.length === 0) die('svc-announce requires --channels (or --channel)');

    const name = requireFlag(flags, 'name');
    const pairs = splitCsv(flags.get('pairs'));
    const otcChannels = splitCsv(flags.get('otc-channels'));
    const note = flags.get('note') ? String(flags.get('note')) : null;
    const offers = parseJsonMaybeFile(flags.get('offers-json'));
    if (flags.get('offers-json') && !offers) die('Invalid --offers-json (expected JSON or @file)');

    const ttlSec = maybeInt(flags.get('ttl-sec'), 'ttl-sec');
    const validUntilUnix = ttlSec ? Math.floor(Date.now() / 1000) + ttlSec : null;

    const tradeId =
      (flags.get('trade-id') && String(flags.get('trade-id')).trim()) ||
      `svc:${name.replaceAll(/\s+/g, '-').slice(0, 64)}`;

    const join = parseBoolFlag(flags.get('join'), true);

    const unsigned = createUnsignedEnvelope({
      v: 1,
      kind: KIND.SVC_ANNOUNCE,
      tradeId,
      body: {
        name,
        ...(pairs.length > 0 ? { pairs } : {}),
        ...(otcChannels.length > 0 ? { otc_channels: otcChannels } : {}),
        ...(note ? { note } : {}),
        ...(offers ? { offers } : {}),
        ...(validUntilUnix ? { valid_until_unix: validUntilUnix } : {}),
      },
    });

    const signed = await withScBridge({ url, token }, async (sc) => {
      if (join) {
        for (const ch of channels) await sc.join(ch);
      }
      const env = await signSwapEnvelope(sc, unsigned);
      for (const ch of channels) {
        const res = await sc.send(ch, env);
        if (res.type !== 'sent') throw new Error(`send failed: ${JSON.stringify(res).slice(0, 200)}`);
      }
      return env;
    });

    process.stdout.write(`${JSON.stringify(signed, null, 2)}\n`);
    return;
  }

  if (cmd === 'svc-announce-loop') {
    const channels = splitCsv(flags.get('channels') || flags.get('channel'));
    if (channels.length === 0) die('svc-announce-loop requires --channels (or --channel)');

    const intervalSec = maybeInt(flags.get('interval-sec'), 'interval-sec') ?? 30;
    if (!Number.isFinite(intervalSec) || intervalSec <= 0) die('Invalid --interval-sec');

    const ttlSec = maybeInt(flags.get('ttl-sec'), 'ttl-sec');
    const tradeId = flags.get('trade-id') ? String(flags.get('trade-id')).trim() : '';

    const watch = parseBoolFlag(flags.get('watch'), true);
    const join = parseBoolFlag(flags.get('join'), true);

    const configRaw = flags.get('config');
    if (!configRaw || configRaw === true) die('svc-announce-loop requires --config');
    const configPath = typeof configRaw === 'string' ? configRaw.trim() : '';
    if (!configPath) die('svc-announce-loop requires --config');

    const readConfig = () => {
      const cfg = parseJsonMaybeFile(configPath);
      if (!cfg || typeof cfg !== 'object') throw new Error('Invalid config (expected JSON object)');
      const name = typeof cfg.name === 'string' ? cfg.name.trim() : '';
      if (!name) throw new Error('Invalid config: missing name');
      return cfg;
    };

    const sc = new ScBridgeClient({ url, token });
    await sc.connect();
    try {
      if (join) {
        for (const ch of channels) {
          const res = await sc.join(ch);
          if (res.type !== 'joined') throw new Error(`join failed: ${JSON.stringify(res).slice(0, 200)}`);
        }
      }

      let dirty = true;
      let lastCfg = null;
      let watcher = null;

      const load = () => {
        const cfg = readConfig();
        lastCfg = cfg;
        dirty = false;
        return cfg;
      };

      if (watch) {
        // Best-effort file watch; if it fails, we still re-read every interval.
        try {
          watcher = fs.watch(configPath.startsWith('@') ? configPath.slice(1) : configPath, () => {
            dirty = true;
          });
        } catch (_e) {}
      }

      const sendOnce = async () => {
        const cfg = dirty || !lastCfg ? load() : lastCfg;
        const name = String(cfg.name || '').trim();
        const pairs = Array.isArray(cfg.pairs) ? cfg.pairs.map((p) => String(p)).filter(Boolean) : [];
        const otcChannels = Array.isArray(cfg.otc_channels)
          ? cfg.otc_channels.map((c) => String(c)).filter(Boolean)
          : [];
        const note = cfg.note !== undefined && cfg.note !== null ? String(cfg.note) : null;
        const offers = cfg.offers !== undefined ? cfg.offers : null;

        const validUntilUnix = ttlSec ? Math.floor(Date.now() / 1000) + ttlSec : null;
        const tid =
          tradeId ||
          (typeof cfg.trade_id === 'string' && cfg.trade_id.trim()) ||
          `svc:${name.replaceAll(/\s+/g, '-').slice(0, 64)}`;

        const unsigned = createUnsignedEnvelope({
          v: 1,
          kind: KIND.SVC_ANNOUNCE,
          tradeId: tid,
          body: {
            name,
            ...(pairs.length > 0 ? { pairs } : {}),
            ...(otcChannels.length > 0 ? { otc_channels: otcChannels } : {}),
            ...(note ? { note } : {}),
            ...(offers ? { offers } : {}),
            ...(validUntilUnix ? { valid_until_unix: validUntilUnix } : {}),
          },
        });

        const signed = await signSwapEnvelope(sc, unsigned);
        for (const ch of channels) {
          const res = await sc.send(ch, signed);
          if (res.type !== 'sent') throw new Error(`send failed: ${JSON.stringify(res).slice(0, 200)}`);
        }
        process.stdout.write(
          `${JSON.stringify({ type: 'svc_announce_sent', channels, trade_id: tid, ts: signed.ts, name })}\n`
        );
      };

      // Send immediately, then on interval.
      await sendOnce();

      const timer = setInterval(() => {
        sendOnce().catch((err) => {
          process.stderr.write(`svc-announce-loop error: ${err?.message ?? String(err)}\n`);
        });
      }, Math.max(250, intervalSec * 1000));

      await new Promise((resolve) => {
        const stop = () => resolve();
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
      });

      clearInterval(timer);
      try {
        watcher?.close?.();
      } catch (_e) {}
    } finally {
      sc.close();
    }
    return;
  }

  if (cmd === 'rfq') {
    const channel = requireFlag(flags, 'channel');
    const tradeId = requireFlag(flags, 'trade-id');
    const btcSats = maybeInt(requireFlag(flags, 'btc-sats'), 'btc-sats');
    const usdtAmount = requireFlag(flags, 'usdt-amount');
    const validUntilUnix = maybeInt(flags.get('valid-until-unix'), 'valid-until-unix');

    const unsigned = createUnsignedEnvelope({
      v: 1,
      kind: KIND.RFQ,
      tradeId,
      body: {
        pair: PAIR.BTC_LN__USDT_SOL,
        direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
        btc_sats: btcSats,
        usdt_amount: usdtAmount,
        valid_until_unix: validUntilUnix || undefined,
      },
    });
    const signed = await withScBridge({ url, token }, (sc) => signSwapEnvelope(sc, unsigned));
    await sendSigned(channel, signed);
    process.stdout.write(`${JSON.stringify(signed, null, 2)}\n`);
    return;
  }

  if (cmd === 'quote') {
    const channel = requireFlag(flags, 'channel');
    const tradeId = requireFlag(flags, 'trade-id');
    const rfqId = requireFlag(flags, 'rfq-id');
    const btcSats = maybeInt(requireFlag(flags, 'btc-sats'), 'btc-sats');
    const usdtAmount = requireFlag(flags, 'usdt-amount');
    const validUntilUnix = maybeInt(requireFlag(flags, 'valid-until-unix'), 'valid-until-unix');

    const unsigned = createUnsignedEnvelope({
      v: 1,
      kind: KIND.QUOTE,
      tradeId,
      body: {
        rfq_id: rfqId,
        pair: PAIR.BTC_LN__USDT_SOL,
        direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
        btc_sats: btcSats,
        usdt_amount: usdtAmount,
        valid_until_unix: validUntilUnix,
      },
    });
    const signed = await withScBridge({ url, token }, (sc) => signSwapEnvelope(sc, unsigned));
    await sendSigned(channel, signed);
    process.stdout.write(`${JSON.stringify(signed, null, 2)}\n`);
    return;
  }

  if (cmd === 'quote-from-rfq') {
    const channel = requireFlag(flags, 'channel');
    const rfqRaw = parseJsonOrBase64(requireFlag(flags, 'rfq-json'));
    if (!rfqRaw) die('Invalid --rfq-json (expected JSON/base64/@file)');

    const v = validateSwapEnvelope(rfqRaw);
    if (!v.ok) die(`Invalid rfq envelope: ${v.error}`);
    if (rfqRaw.kind !== KIND.RFQ) die(`Invalid rfq envelope kind=${rfqRaw.kind}`);

    const { sig: _sig, signer: _signer, ...rfqUnsigned } = rfqRaw;
    const rfqId = hashUnsignedEnvelope(rfqUnsigned);

    const tradeId = String(rfqRaw.trade_id);
    const btcSats = maybeInt(flags.get('btc-sats'), 'btc-sats') ?? rfqRaw.body.btc_sats;
    const usdtAmount = (flags.get('usdt-amount') && String(flags.get('usdt-amount'))) || rfqRaw.body.usdt_amount;
    const validUntilUnix =
      maybeInt(flags.get('valid-until-unix'), 'valid-until-unix') || Math.floor(Date.now() / 1000) + 60;

    const unsigned = createUnsignedEnvelope({
      v: 1,
      kind: KIND.QUOTE,
      tradeId,
      body: {
        rfq_id: rfqId,
        pair: PAIR.BTC_LN__USDT_SOL,
        direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
        btc_sats: btcSats,
        usdt_amount: usdtAmount,
        valid_until_unix: validUntilUnix,
      },
    });

    const signed = await withScBridge({ url, token }, (sc) => signSwapEnvelope(sc, unsigned));
    await sendSigned(channel, signed);
    process.stdout.write(`${JSON.stringify(signed, null, 2)}\n`);
    process.stdout.write(`rfq_id=${rfqId}\n`);
    return;
  }

  if (cmd === 'quote-accept') {
    const channel = requireFlag(flags, 'channel');
    const quoteRaw = parseJsonOrBase64(requireFlag(flags, 'quote-json'));
    if (!quoteRaw) die('Invalid --quote-json (expected JSON/base64/@file)');

    const v = validateSwapEnvelope(quoteRaw);
    if (!v.ok) die(`Invalid quote envelope: ${v.error}`);
    if (quoteRaw.kind !== KIND.QUOTE) die(`Invalid quote envelope kind=${quoteRaw.kind}`);

    const quoteId = hashUnsignedEnvelope(stripSignature(quoteRaw));
    const rfqId = String(quoteRaw.body.rfq_id);
    const tradeId = String(quoteRaw.trade_id);

    const unsigned = createUnsignedEnvelope({
      v: 1,
      kind: KIND.QUOTE_ACCEPT,
      tradeId,
      body: { rfq_id: rfqId, quote_id: quoteId },
    });
    const signed = await withScBridge({ url, token }, (sc) => signSwapEnvelope(sc, unsigned));
    await sendSigned(channel, signed);
    process.stdout.write(`${JSON.stringify(signed, null, 2)}\n`);
    process.stdout.write(`quote_id=${quoteId}\n`);
    return;
  }

  if (cmd === 'swap-invite-from-accept') {
    const channel = requireFlag(flags, 'channel');
    const acceptRaw = parseJsonOrBase64(requireFlag(flags, 'accept-json'));
    if (!acceptRaw) die('Invalid --accept-json (expected JSON/base64/@file)');

    const v = validateSwapEnvelope(acceptRaw);
    if (!v.ok) die(`Invalid quote_accept envelope: ${v.error}`);
    if (acceptRaw.kind !== KIND.QUOTE_ACCEPT) die(`Invalid accept envelope kind=${acceptRaw.kind}`);

    const tradeId = String(acceptRaw.trade_id);
    const swapChannel =
      (flags.get('swap-channel') && String(flags.get('swap-channel')).trim()) || `swap:${tradeId}`;
    const welcomeText =
      (flags.get('welcome-text') && String(flags.get('welcome-text'))) || `swap ${tradeId}`;
    const ttlSec = maybeInt(flags.get('ttl-sec'), 'ttl-sec');

    const inviteePubKey = String(acceptRaw.signer || '').trim().toLowerCase();
    if (!inviteePubKey) die('accept envelope missing signer pubkey');

    const rfqId = String(acceptRaw.body.rfq_id);
    const quoteId = String(acceptRaw.body.quote_id);

    const res = await withScBridge({ url, token }, async (sc) => {
      const { signerHex: ownerPubKey } = await signViaBridge(sc, { _probe: 'swap_invite_owner' });
      const welcomePayload = normalizeWelcomePayload({
        channel: swapChannel,
        ownerPubKey,
        text: welcomeText,
        issuedAt: Date.now(),
        version: 1,
      });
      const { sigHex: welcomeSig } = await signViaBridge(sc, welcomePayload);
      const welcome = { payload: welcomePayload, sig: welcomeSig };

      const issuedAt = Date.now();
      const ttlMs = ttlSec !== null ? ttlSec * 1000 : 7 * 24 * 3600 * 1000;
      const invitePayload = normalizeInvitePayload({
        channel: swapChannel,
        inviteePubKey,
        inviterPubKey: ownerPubKey,
        inviterAddress: null,
        issuedAt,
        expiresAt: issuedAt + ttlMs,
        nonce: Math.random().toString(36).slice(2, 10),
        version: 1,
      });
      const { sigHex: inviteSig } = await signViaBridge(sc, invitePayload);
      const invite = createSignedInvite(invitePayload, () => inviteSig, { welcome });

      const unsigned = createUnsignedEnvelope({
        v: 1,
        kind: KIND.SWAP_INVITE,
        tradeId,
        body: {
          rfq_id: rfqId,
          quote_id: quoteId,
          swap_channel: swapChannel,
          owner_pubkey: ownerPubKey,
          invite,
          welcome,
        },
      });
      const signed = await signSwapEnvelope(sc, unsigned);
      return { signed, swapChannel, ownerPubKey, welcome, invite };
    });

    await sendSigned(channel, res.signed);
    process.stdout.write(`${JSON.stringify(res.signed, null, 2)}\n`);
    process.stdout.write(`swap_channel=${res.swapChannel}\n`);
    process.stdout.write(`owner_pubkey=${res.ownerPubKey}\n`);
    process.stdout.write(`welcome_b64=${toB64Json(res.welcome)}\n`);
    process.stdout.write(`invite_b64=${toB64Json(res.invite)}\n`);
    return;
  }

  if (cmd === 'join-from-swap-invite') {
    const swapInviteRaw = parseJsonOrBase64(requireFlag(flags, 'swap-invite-json'));
    if (!swapInviteRaw) die('Invalid --swap-invite-json (expected JSON/base64/@file)');

    const v = validateSwapEnvelope(swapInviteRaw);
    if (!v.ok) die(`Invalid swap_invite envelope: ${v.error}`);
    if (swapInviteRaw.kind !== KIND.SWAP_INVITE) die(`Invalid envelope kind=${swapInviteRaw.kind}`);

    const swapChannel = String(swapInviteRaw.body.swap_channel || '').trim();
    if (!swapChannel) die('swap_invite missing swap_channel');

    const invite =
      swapInviteRaw.body.invite ||
      (swapInviteRaw.body.invite_b64 ? parseJsonOrBase64(swapInviteRaw.body.invite_b64) : null);
    const welcome =
      swapInviteRaw.body.welcome ||
      (swapInviteRaw.body.welcome_b64 ? parseJsonOrBase64(swapInviteRaw.body.welcome_b64) : null);

    const res = await withScBridge({ url, token }, (sc) => sc.join(swapChannel, { invite, welcome }));
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }

  if (cmd === 'terms') {
    const channel = requireFlag(flags, 'channel');
    const tradeId = requireFlag(flags, 'trade-id');
    const btcSats = maybeInt(requireFlag(flags, 'btc-sats'), 'btc-sats');
    const usdtAmount = requireFlag(flags, 'usdt-amount');
    const solMint = requireFlag(flags, 'sol-mint');
    const solRecipient = requireFlag(flags, 'sol-recipient');
    const solRefund = requireFlag(flags, 'sol-refund');
    const solRefundAfter = maybeInt(requireFlag(flags, 'sol-refund-after-unix'), 'sol-refund-after-unix');
    const lnReceiverPeer = requireFlag(flags, 'ln-receiver-peer');
    const lnPayerPeer = requireFlag(flags, 'ln-payer-peer');
    const platformFeeBps = maybeInt(requireFlag(flags, 'platform-fee-bps'), 'platform-fee-bps');
    const tradeFeeBps = maybeInt(requireFlag(flags, 'trade-fee-bps'), 'trade-fee-bps');
    const tradeFeeCollector = requireFlag(flags, 'trade-fee-collector');
    const platformFeeCollector = flags.get('platform-fee-collector')
      ? String(flags.get('platform-fee-collector')).trim()
      : null;
    const termsValidUntil = maybeInt(flags.get('terms-valid-until-unix'), 'terms-valid-until-unix');

    const unsigned = createUnsignedEnvelope({
      v: 1,
      kind: KIND.TERMS,
      tradeId,
      body: {
        pair: PAIR.BTC_LN__USDT_SOL,
        direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
        btc_sats: btcSats,
        usdt_amount: usdtAmount,
        usdt_decimals: 6,
        sol_mint: solMint,
        sol_recipient: solRecipient,
        sol_refund: solRefund,
        sol_refund_after_unix: solRefundAfter,
        platform_fee_bps: platformFeeBps,
        trade_fee_bps: tradeFeeBps,
        trade_fee_collector: tradeFeeCollector,
        platform_fee_collector: platformFeeCollector || undefined,
        ln_receiver_peer: lnReceiverPeer,
        ln_payer_peer: lnPayerPeer,
        terms_valid_until_unix: termsValidUntil || undefined,
      },
    });
    const signed = await withScBridge({ url, token }, (sc) => signSwapEnvelope(sc, unsigned));
    await sendSigned(channel, signed);
    process.stdout.write(`${JSON.stringify(signed, null, 2)}\n`);
    process.stdout.write(`terms_hash=${hashTermsEnvelope(signed)}\n`);
    return;
  }

  if (cmd === 'accept') {
    const channel = requireFlag(flags, 'channel');
    const tradeId = requireFlag(flags, 'trade-id');
    const termsHash = flags.get('terms-hash');
    const termsJson = flags.get('terms-json');
    if (!termsHash && !termsJson) die('accept requires --terms-hash or --terms-json');
    if (termsHash && termsJson) die('accept requires exactly one of --terms-hash or --terms-json');
    const hash = termsHash
      ? String(termsHash).trim().toLowerCase()
      : hashTermsEnvelope(JSON.parse(readTextMaybeFile(String(termsJson))));

    const unsigned = createUnsignedEnvelope({
      v: 1,
      kind: KIND.ACCEPT,
      tradeId,
      body: { terms_hash: hash },
    });
    const signed = await withScBridge({ url, token }, (sc) => signSwapEnvelope(sc, unsigned));
    await sendSigned(channel, signed);
    process.stdout.write(`${JSON.stringify(signed, null, 2)}\n`);
    return;
  }

  die(`Unknown command: ${cmd}\n\n${usage()}`);
}

main().catch((err) => {
  const msg = err?.stack || err?.message || String(err);
  die(msg);
});
