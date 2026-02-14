function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function pow10BigInt(n) {
  let out = 1n;
  for (let i = 0; i < n; i += 1) out *= 10n;
  return out;
}

function decimalToAtomicString(value, decimals) {
  // Deterministic conversion for prompt-mode robustness.
  // - If already an integer string: return it.
  // - If a decimal string: interpret as "display units" and convert to atomic.
  // - If a number: convert via fixed decimals (avoid float math where possible).
  if (value === null || value === undefined) return value;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return value;
    if (Number.isInteger(value) && value >= 0) return String(value);
    // Convert to a fixed decimal string then parse it.
    // This is a best-effort repair for model outputs; executor still validates.
    return decimalToAtomicString(value.toFixed(decimals), decimals);
  }

  if (typeof value !== 'string') return value;

  let s = value.trim();
  if (!s) return value;

  // Common formatting artifacts
  s = s.replaceAll('_', '').replaceAll(',', '');

  // If it looks like "0.12 usdt", keep the first token only.
  // This is conservative: we only proceed if the token is numeric below.
  s = s.split(/\s+/)[0] || '';
  if (!s) return value;

  if (/^[0-9]+$/.test(s)) return s; // already atomic

  // Normalize some decimal edge-cases: ".5" -> "0.5", "1." -> "1.0"
  if (s.startsWith('.')) s = `0${s}`;
  if (s.endsWith('.')) s = `${s}0`;

  const m = s.match(/^([+]?[0-9]+)(?:\.([0-9]+))?$/);
  if (!m) return value;

  const intPart = m[1].replace(/^\+/, '');
  const fracPart = m[2] || '';
  if (fracPart.length > decimals) return value;

  const fracPadded = (fracPart + '0'.repeat(decimals)).slice(0, decimals);
  const atomic = BigInt(intPart || '0') * pow10BigInt(decimals) + BigInt(fracPadded || '0');
  if (atomic < 0n) return value;
  return atomic.toString();
}

function coerceUsdtAtomic(value) {
  return decimalToAtomicString(value, 6);
}

function coerceSolLamports(value) {
  return decimalToAtomicString(value, 9);
}

export function repairToolArguments(toolName, args) {
  // Best-effort repair for common model mistakes. Keep this tightly scoped and conservative.
  if (!isObject(args)) return args;

  // Models often flatten offer fields (have/want/btc_sats/...) at the top-level for offer_post.
  // The schema requires these to live under offers[].
  if (toolName === 'intercomswap_offer_post') {
    const out = { ...args };
    // Some models use "channel" (singular) instead of "channels" (array).
    if (!Array.isArray(out.channels) && typeof out.channel === 'string' && out.channel.trim()) {
      out.channels = [out.channel.trim()];
      delete out.channel;
    }

    const offerKeys = [
      'pair',
      'have',
      'want',
      'btc_sats',
      'usdt_amount',
      'max_platform_fee_bps',
      'max_trade_fee_bps',
      'max_total_fee_bps',
      'min_sol_refund_window_sec',
      'max_sol_refund_window_sec',
    ];
    const flattened = offerKeys.filter((k) => k in out);
    if (flattened.length > 0) {
      // Always delete flattened top-level keys; executor rejects them.
      if (!Array.isArray(out.offers) || out.offers.length === 0 || !isObject(out.offers[0])) {
        const o = {};
        for (const k of flattened) o[k] = out[k];
        out.offers = [o];
      } else {
        // Merge into offers[0] only if the key is missing there (avoid silent overrides).
        const merged = { ...(out.offers[0] || {}) };
        for (const k of flattened) {
          if (!(k in merged)) merged[k] = out[k];
        }
        out.offers = [merged].concat(out.offers.slice(1));
      }
      for (const k of flattened) delete out[k];
    } else if (!Array.isArray(out.offers)) {
      // If offers is missing entirely, but there were no flattened keys, leave as-is and let schema validation fail.
    }

    // Coerce USDT amounts (prompt models often emit "0.12" instead of "120000").
    if (Array.isArray(out.offers)) {
      out.offers = out.offers.map((o) => {
        if (!isObject(o)) return o;
        if (!('usdt_amount' in o)) return o;
        const next = { ...o };
        next.usdt_amount = coerceUsdtAtomic(next.usdt_amount);
        return next;
      });
    }
    return out;
  }

  if (toolName === 'intercomswap_rfq_post' || toolName === 'intercomswap_quote_post' || toolName === 'intercomswap_terms_post') {
    const out = { ...args };
    if ('usdt_amount' in out) out.usdt_amount = coerceUsdtAtomic(out.usdt_amount);
    return out;
  }

  if (toolName === 'intercomswap_sol_airdrop' || toolName === 'intercomswap_sol_transfer_sol') {
    const out = { ...args };
    if ('lamports' in out) out.lamports = coerceSolLamports(out.lamports);
    return out;
  }

  return args;
}
