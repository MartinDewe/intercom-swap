import { randomBytes, randomUUID } from 'node:crypto';

import { buildIntercomswapSystemPrompt } from './system.js';
import { INTERCOMSWAP_TOOLS } from './tools.js';
import { compactToolsForModel } from './toolsCompact.js';
import { OpenAICompatibleClient } from './openaiClient.js';
import { AuditLog } from './audit.js';
import { SecretStore, isSecretHandle } from './secrets.js';
import { repairToolArguments } from './repair.js';
import { stableStringify } from '../util/stableStringify.js';

function nowMs() {
  return Date.now();
}

function parseEveryIntervalSec(prompt) {
  const p = String(prompt || '');
  const m = p.match(
    /\bevery\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/i
  );
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return null;
  const unit = String(m[2] || '').toLowerCase();
  if (!unit) return n;
  if (unit.startsWith('s')) return n;
  if (unit.startsWith('m')) return n * 60;
  if (unit.startsWith('h')) return n * 3600;
  return null;
}

function parseSatsForUsdt(prompt) {
  const p = String(prompt || '');
  // Only handle narrow, explicit phrases. If this doesn't match, we fall back to the LLM.
  // Examples:
  // - "sell 1002 sats for 0.33 usdt"
  // - "buy 1002 sats for 0.33 usdt"
  const mSats = p.match(/\b(sell|buy)\s+(\d+)\s*(sat|sats)\b/i);
  const mUsdt = p.match(/\bfor\s+([0-9]+(?:\.[0-9]+)?)\s*usdt\b/i);
  if (!mSats || !mUsdt) return null;
  const verb = String(mSats[1] || '').toLowerCase();
  const sats = Number.parseInt(String(mSats[2] || ''), 10);
  const usdt = String(mUsdt[1] || '').trim();
  if (!Number.isFinite(sats) || !Number.isInteger(sats) || sats < 1) return null;
  if (!usdt || !/^[0-9]+(?:\.[0-9]+)?$/.test(usdt)) return null;
  return { verb, btc_sats: sats, usdt_amount: usdt };
}

function tryParseSimpleAutopostToolCall(prompt) {
  const p = String(prompt || '').trim();
  if (!p) return null;
  // Avoid accidental side effects for question-like prompts.
  if (/\?\s*$/.test(p)) return null;
  if (!/\brepeat\b/i.test(p)) return null;

  const intervalSec = parseEveryIntervalSec(p);
  if (!intervalSec) return null;

  const terms = parseSatsForUsdt(p);
  if (!terms) return null;

  const rand = randomBytes(4).toString('hex');
  const nowMs = Date.now();
  const ttlSec = 24 * 3600; // default 1 day if not explicitly specified
  const channel = '0000intercomswapbtcusdt';

  if (terms.verb === 'sell') {
    // SELL sats/BTC for USDT => RFQ (BTC_LN->USDT_SOL)
    return {
      name: 'intercomswap_autopost_start',
      arguments: {
        name: `rfq_prompt_${rand}_${nowMs}`,
        tool: 'intercomswap_rfq_post',
        interval_sec: intervalSec,
        ttl_sec: ttlSec,
        args: {
          channel,
          trade_id: `rfq-${nowMs}-${rand}`,
          btc_sats: terms.btc_sats,
          usdt_amount: terms.usdt_amount,
        },
      },
    };
  }

  if (terms.verb === 'buy') {
    // BUY sats/BTC for USDT => Offer (have USDT, want BTC)
    return {
      name: 'intercomswap_autopost_start',
      arguments: {
        name: `offer_prompt_${rand}_${nowMs}`,
        tool: 'intercomswap_offer_post',
        interval_sec: intervalSec,
        ttl_sec: ttlSec,
        args: {
          channels: [channel],
          name: 'maker:prompt',
          rfq_channels: [channel],
          offers: [{ btc_sats: terms.btc_sats, usdt_amount: terms.usdt_amount }],
        },
      },
    };
  }

  return null;
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (_e) {
    return JSON.stringify({ error: 'unserializable' });
  }
}

function normalizeToolResponseMessage({ toolFormat, toolCall, result }) {
  const content = typeof result === 'string' ? result : safeJsonStringify(result);
  if (toolFormat === 'functions') {
    return { role: 'function', name: toolCall.name, content };
  }
  // tools format
  return {
    role: 'tool',
    tool_call_id: toolCall.id || undefined,
    content,
  };
}

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function safeJsonParse(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, value: null, error: 'empty' };
  try {
    return { ok: true, value: JSON.parse(raw), error: null };
  } catch (err) {
    return { ok: false, value: null, error: err?.message ?? String(err) };
  }
}

function isContextLimitError(err) {
  const msg = String(err?.message || err || '');
  return /maximum context length/i.test(msg) || /context length/i.test(msg) || /input tokens/i.test(msg);
}

function isValidStructuredFinal(value) {
  if (!isObject(value)) return { ok: false, error: 'final must be a JSON object' };
  const type = value.type;
  if (typeof type !== 'string' || !type.trim()) return { ok: false, error: 'final.type must be a non-empty string' };
  const t = type.trim();
  // We only accept {"type":"message","text":"..."} as the final output.
  // Any other structured JSON object is treated as INVALID_OUTPUT so the model re-emits
  // either a tool call or a message (prevents "plan JSON" like {type:"auto_post_schedule"}).
  if (t !== 'message') return { ok: false, error: 'final.type must be "message" (use tool calls to act)' };
  const text = value.text;
  if (typeof text !== 'string') return { ok: false, error: 'final.text must be a string when final.type=="message"' };
  return { ok: true, error: null };
}

function extractJsonObjects(text, { maxObjects = 25, maxChars = 200_000 } = {}) {
  const s = String(text ?? '').slice(0, maxChars);
  const out = [];

  let i = 0;
  while (i < s.length && out.length < maxObjects) {
    // Find next '{'
    while (i < s.length && s[i] !== '{') i += 1;
    if (i >= s.length) break;

    const start = i;
    let depth = 0;
    let inString = false;
    let esc = false;
    let j = i;
    for (; j < s.length; j += 1) {
      const ch = s[j];
      if (inString) {
        if (esc) {
          esc = false;
          continue;
        }
        if (ch === '\\\\') {
          esc = true;
          continue;
        }
        if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') depth += 1;
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          j += 1;
          break;
        }
      }
    }

    if (depth !== 0) break; // Unbalanced
    const chunk = s.slice(start, j).trim();
    out.push(chunk);
    i = j;
  }

  return out;
}

function tryParseArgsObject(value) {
  if (value === null || value === undefined) return { ok: true, args: {} };
  if (isObject(value)) return { ok: true, args: value };
  if (typeof value === 'string') {
    const parsed = safeJsonParse(value);
    if (parsed.ok && isObject(parsed.value)) return { ok: true, args: parsed.value };
  }
  return { ok: false, args: null };
}

// Fallback for models/servers that "describe" a tool call instead of returning tool_calls.
function extractToolCallFromText(content, { allowedNames }) {
  const chunks = extractJsonObjects(content);
  const candidates = [];
  for (const chunk of chunks) {
    const parsed = safeJsonParse(chunk);
    if (!parsed.ok) continue;
    const obj = parsed.value;
    if (!isObject(obj)) continue;
    const objType = typeof obj.type === 'string' ? obj.type.trim() : '';
    const toolish =
      !objType ||
      objType === 'tool' ||
      objType === 'tool_call' ||
      objType === 'function' ||
      objType === 'function_call';

    // 1) {"name":"tool","arguments":{...}} (preferred)
    {
      const name = typeof obj.name === 'string' ? obj.name.trim() : '';
      if (name && allowedNames && allowedNames.has(name)) {
        // If the model uses a {type:"..."} envelope, only accept tool calls from type=="tool".
        if (objType && !toolish) {
          // Not a tool call.
        } else if (!('arguments' in obj) && !toolish) {
          // Avoid misinterpreting arbitrary JSON as a tool call.
        } else {
          const r = tryParseArgsObject(obj.arguments);
          if (r.ok) candidates.push({ name, arguments: r.args, argumentsRaw: safeJsonStringify(r.args) });
        }
      }
    }

    // 2) {"tool":"tool","args":{...}}
    {
      const name = typeof obj.tool === 'string' ? obj.tool.trim() : '';
      if (name && allowedNames && allowedNames.has(name)) {
        if (objType && !toolish) {
          // Not a tool call (eg, a tool_result envelope).
        } else if (!('args' in obj) && !toolish) {
          // Avoid treating {"tool":"..."} as a tool call unless it's explicitly type:"tool".
        } else {
          const argValue = 'args' in obj ? obj.args : 'arguments' in obj ? obj.arguments : undefined;
          const r = tryParseArgsObject(argValue);
          if (r.ok) candidates.push({ name, arguments: r.args, argumentsRaw: safeJsonStringify(r.args) });
        }
      }
    }

    // 2b) {"type":"tool_call","tool":{"name":"...","arguments":{...}}} (nested form)
    if (allowedNames && toolish) {
      const inner = isObject(obj.tool) ? obj.tool : isObject(obj.tool_call) ? obj.tool_call : null;
      if (inner) {
        const name = typeof inner.name === 'string' ? inner.name.trim() : '';
        if (name && allowedNames.has(name)) {
          const r = tryParseArgsObject(inner.arguments);
          if (r.ok) candidates.push({ name, arguments: r.args, argumentsRaw: safeJsonStringify(r.args) });
        }
      }
    }

    // 3) {"tool_calls":[{"name":"...","arguments":{...}}, ...]}
    if (Array.isArray(obj.tool_calls) && allowedNames) {
      for (const tc of obj.tool_calls) {
        if (!isObject(tc)) continue;
        const name = typeof tc.name === 'string' ? tc.name.trim() : '';
        if (!name || !allowedNames.has(name)) continue;
        const r = tryParseArgsObject(tc.arguments);
        if (!r.ok) continue;
        candidates.push({ name, arguments: r.args, argumentsRaw: safeJsonStringify(r.args) });
      }
    }

    // 4) {"type":"function","function":{"name":"...","arguments":"{...}"}} (OpenAI-ish)
    if (allowedNames && isObject(obj.function)) {
      const name = typeof obj.function.name === 'string' ? obj.function.name.trim() : '';
      if (name && allowedNames.has(name)) {
        const r = tryParseArgsObject(obj.function.arguments);
        if (r.ok) candidates.push({ name, arguments: r.args, argumentsRaw: safeJsonStringify(r.args) });
      }
    }

    // 5) {"tool_name": {...}} single-key mapping style (common in weaker tool-call models)
    if (allowedNames) {
      const keys = Object.keys(obj);
      if (keys.length === 1) {
        const k = String(keys[0] || '').trim();
        if (k && allowedNames.has(k)) {
          const r = tryParseArgsObject(obj[k]);
          if (r.ok) candidates.push({ name: k, arguments: r.args, argumentsRaw: safeJsonStringify(r.args) });
        }
      }
    }
  }
  if (candidates.length === 0) return null;
  const last = candidates[candidates.length - 1];
  return {
    id: '',
    name: last.name,
    arguments: last.arguments,
    argumentsRaw: last.argumentsRaw || safeJsonStringify(last.arguments),
    parseError: null,
    fromText: true,
  };
}

function shouldSealKey(key) {
  const k = String(key || '').toLowerCase();
  if (k.includes('preimage')) return true;

  // Invites/welcomes: seal only the actual payload fields, not policy/metadata fields like
  // invite_required/invite_prefixes/inviter_keys which are safe and needed for operator UX.
  if (k === 'invite' || k === 'invite_b64' || k.endsWith('_invite_b64')) return true;
  if (k === 'welcome' || k === 'welcome_b64' || k.endsWith('_welcome_b64')) return true;

  // Credentials/secrets.
  if (k.includes('api_key') || k.includes('apikey')) return true;
  if (k.includes('authorization') || k === 'auth') return true;
  if (k.includes('macaroon')) return true;
  if (k.includes('seed')) return true;
  if (k.includes('password')) return true;

  return false;
}

// Ensures tool results sent back to the model do not include secrets.
// Instead, secrets are replaced with opaque handles stored in the session SecretStore.
function sealToolResultForModel(value, secrets, { path = '' } = {}) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();

  if (Array.isArray(value)) {
    return value.map((v, i) => sealToolResultForModel(v, secrets, { path: `${path}[${i}]` }));
  }

  if (isObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const nextPath = path ? `${path}.${k}` : k;
      if (shouldSealKey(k) && v !== null && v !== undefined) {
        // Avoid double-wrapping if tool already returns a handle.
        if (typeof v === 'string' && isSecretHandle(v)) out[k] = v;
        else out[k] = secrets.put(v, { key: k, path: nextPath });
      } else {
        out[k] = sealToolResultForModel(v, secrets, { path: nextPath });
      }
    }
    return out;
  }

  // Fallback: attempt to serialize.
  return safeJsonStringify(value);
}

function messageHasToolCalls(message) {
  if (!message || typeof message !== 'object') return false;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
  if (message.function_call && typeof message.function_call === 'object') return true;
  return false;
}

function isRepeatableTool(name) {
  const n = String(name || '').trim();
  // Allow polling tools to repeat without triggering loop-break logic.
  return n === 'intercomswap_sc_wait_envelope' || n === 'intercomswap_ln_pay_status';
}

export class PromptRouter {
  constructor({
    llmConfig,
    llmClient = null,
    toolExecutor,
    auditDir = 'onchain/prompt/audit',
    maxSteps = 12,
    maxRepairs = 2,
    agentRole = '',
  }) {
    if (!toolExecutor) throw new Error('PromptRouter requires toolExecutor');
    if (!llmConfig || typeof llmConfig !== 'object') throw new Error('PromptRouter requires llmConfig');
    if (!llmConfig.baseUrl) throw new Error('PromptRouter requires llmConfig.baseUrl');
    if (!llmConfig.model) throw new Error('PromptRouter requires llmConfig.model');

    this.toolExecutor = toolExecutor;
    this.auditDir = auditDir;
    this.maxSteps = maxSteps;
    this.maxRepairs = Number.isFinite(maxRepairs) ? Math.max(0, Math.trunc(maxRepairs)) : 2;
    this.agentRole = String(agentRole || '').trim();

    const cfg = llmConfig;
    this.llmConfig = cfg;

    this.llmClient =
      llmClient ||
      new OpenAICompatibleClient({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        defaultModel: cfg.model,
        timeoutMs: cfg.timeoutMs,
        toolFormat: cfg.toolFormat,
      });

    this._sessions = new Map(); // sessionId -> { messages }
  }

  _getSession(sessionId) {
    const id = sessionId || randomUUID();
    if (!this._sessions.has(id)) {
      this._sessions.set(id, {
        messages: [{ role: 'system', content: buildIntercomswapSystemPrompt({ role: this.agentRole }) }],
        secrets: new SecretStore(),
      });
    }
    return { id, session: this._sessions.get(id) };
  }

  async _selectToolNamesForPrompt(prompt, { allTools, maxTools = 16, signal = null } = {}) {
    const p = String(prompt ?? '').trim();
    if (!p) return null;
    const list = Array.isArray(allTools) ? allTools : [];
    if (list.length === 0) return null;

    const maxLines = 500;
    const lines = [];
    for (const t of list) {
      const name = t?.function?.name;
      if (typeof name !== 'string' || !name.trim()) continue;
      const desc = typeof t?.function?.description === 'string' ? t.function.description.trim() : '';
      lines.push(`- ${name}${desc ? `: ${desc}` : ''}`);
      if (lines.length >= maxLines) break;
    }

    const limit = Math.max(1, Math.min(64, Math.trunc(Number(maxTools) || 16)));
    const sys =
      'You are a tool selection router.\n' +
      'Pick the smallest set of tool names needed to satisfy the user prompt.\n\n' +
      'Output STRICT JSON only:\n' +
      '{"tools":["tool_name_1","tool_name_2",...]}\n\n' +
      `Rules:\n- Use ONLY tool names from the list.\n- Output at most ${limit} tools.\n- If no tools are needed, output {"tools":[]}.\n\n` +
      `Available tools:\n${lines.join('\n')}`;

    const extraBody = {};
    if (this.llmConfig.extraBody && typeof this.llmConfig.extraBody === 'object') Object.assign(extraBody, this.llmConfig.extraBody);
    if (this.llmConfig.responseFormat && typeof this.llmConfig.responseFormat === 'object') {
      extraBody.response_format = this.llmConfig.responseFormat;
    }

    const out = await this.llmClient.chatCompletions({
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: p },
      ],
      tools: null,
      toolChoice: 'none',
      maxTokens: 256,
      temperature: 0,
      topP: 0.1,
      extraBody: Object.keys(extraBody).length > 0 ? extraBody : null,
      signal,
    });

    const parsed = safeJsonParse(out.content || '');
    if (!parsed.ok || !isObject(parsed.value)) return null;
    const tools = parsed.value.tools;
    if (!Array.isArray(tools)) return null;
    const names = [];
    const seen = new Set();
    for (const raw of tools) {
      const n = typeof raw === 'string' ? raw.trim() : '';
      if (!n) continue;
      if (seen.has(n)) continue;
      seen.add(n);
      names.push(n);
      if (names.length >= limit) break;
    }
    return names;
  }

  async run({
    prompt,
    sessionId = null,
    autoApprove = false,
    dryRun = false,
    maxSteps = null,
    emit = null,
    signal = null,
  }) {
    const p = String(prompt ?? '').trim();
    if (!p) throw new Error('prompt is required');
    if (signal?.aborted) throw signal.reason || new Error('aborted');

    const { id, session } = this._getSession(sessionId);
    const audit = new AuditLog({ dir: this.auditDir, sessionId: id });
    audit.write('prompt', { sessionId: id, prompt: p, autoApprove, dryRun });
    if (typeof emit === 'function') {
      await emit({ type: 'run_start', session_id: id, started_at: nowMs(), auto_approve: autoApprove, dry_run: dryRun });
    }

    const toolsAll = INTERCOMSWAP_TOOLS;
    const allowedToolNamesAll = new Set(
      toolsAll.map((t) => t?.function?.name).filter((n) => typeof n === 'string' && n.trim())
    );

    const toolsCompactEnabled = this.llmConfig?.toolsCompact !== false; // default true
    const toolsCompactOpts = {
      keepToolDescriptions: this.llmConfig?.toolsCompactKeepToolDescriptions !== false, // default true
      keepSchemaDescriptions: Boolean(this.llmConfig?.toolsCompactKeepSchemaDescriptions), // default false
    };
    const toolsForModelAll = toolsCompactEnabled ? compactToolsForModel(toolsAll, toolsCompactOpts) : toolsAll;
    let toolsForModel = toolsForModelAll;
    let allowedToolNames = new Set(
      toolsForModel.map((t) => t?.function?.name).filter((n) => typeof n === 'string' && n.trim())
    );
    const toolFormat = this.llmConfig.toolFormat === 'functions' ? 'functions' : 'tools';

    // Direct tool-call mode: if the user prompt itself is a tool call JSON object,
    // execute it without invoking the LLM. This is useful for deterministic
    // programmatic control (and when the LLM endpoint is offline).
    {
      const parsed = safeJsonParse(p);
      const obj = parsed.ok ? parsed.value : null;
      const isTool = isObject(obj) && String(obj.type || '').trim() === 'tool';
      const name = isTool && typeof obj.name === 'string' ? obj.name.trim() : '';
      const args = isTool && isObject(obj.arguments) ? obj.arguments : null;
      if (isTool && name && allowedToolNamesAll.has(name) && args) {
        const repairedArgs = repairToolArguments(name, args);
        audit.write('direct_tool_prompt', { sessionId: id, name, arguments: args, autoApprove, dryRun });
        const toolStartedAt = nowMs();
        const toolResult = await this.toolExecutor.execute(name, repairedArgs, { autoApprove, dryRun, secrets: session.secrets });
        const toolResultForModel = sealToolResultForModel(toolResult, session.secrets);
        const toolStep = {
          type: 'tool',
          name,
          arguments: repairedArgs,
          started_at: toolStartedAt,
          duration_ms: nowMs() - toolStartedAt,
          result: toolResultForModel,
        };
        audit.write('tool_result', toolStep);
        if (typeof emit === 'function') await emit(toolStep);
        if (typeof emit === 'function') {
          await emit({
            type: 'final',
            session_id: id,
            content: safeJsonStringify(toolResultForModel),
            content_json: toolResultForModel,
            steps: 1,
          });
        }
        return {
          session_id: id,
          content: safeJsonStringify(toolResultForModel),
          content_json: toolResultForModel,
          steps: [toolStep],
        };
      }
    }

    // Narrow natural-language shortcut for common broadcast tasks:
    // "sell/buy <n> sats for <x> usdt. repeat every <t>" => autopost RFQ/Offer.
    // This avoids LLM misinterpretation and reduces reliance on flaky endpoints.
    {
      const nlTool = tryParseSimpleAutopostToolCall(p);
      if (nlTool && typeof nlTool.name === 'string' && allowedToolNamesAll.has(nlTool.name) && isObject(nlTool.arguments)) {
        const repairedArgs = repairToolArguments(nlTool.name, nlTool.arguments);
        audit.write('nl_tool_prompt', { sessionId: id, prompt: p, name: nlTool.name, arguments: repairedArgs, autoApprove, dryRun });
        const toolStartedAt = nowMs();
        const toolResult = await this.toolExecutor.execute(nlTool.name, repairedArgs, { autoApprove, dryRun, secrets: session.secrets });
        const toolResultForModel = sealToolResultForModel(toolResult, session.secrets);
        const toolStep = {
          type: 'tool',
          name: nlTool.name,
          arguments: repairedArgs,
          started_at: toolStartedAt,
          duration_ms: nowMs() - toolStartedAt,
          result: toolResultForModel,
        };
        audit.write('tool_result', toolStep);
        if (typeof emit === 'function') await emit(toolStep);
        if (typeof emit === 'function') {
          await emit({
            type: 'final',
            session_id: id,
            content: safeJsonStringify(toolResultForModel),
            content_json: toolResultForModel,
            steps: 1,
          });
        }
        return {
          session_id: id,
          content: safeJsonStringify(toolResultForModel),
          content_json: toolResultForModel,
          steps: [toolStep],
        };
      }
    }

    session.messages.push({ role: 'user', content: p });

    // Optional "tool selection" pre-pass:
    // When enabled, we ask the LLM (without tool schemas) to pick which tool names are relevant,
    // then run the main tool-calling pass with only that subset. This keeps prompting usable
    // with 32k-context models and reduces output truncation.
    if (this.llmConfig?.toolsSelectPass) {
      try {
        const selected = await this._selectToolNamesForPrompt(p, {
          allTools: toolsAll,
          maxTools: this.llmConfig?.toolsSelectMaxTools ?? 16,
          signal,
        });
        if (Array.isArray(selected) && selected.length > 0) {
          const keep = new Set(selected);
          const filteredAll = toolsAll.filter((t) => keep.has(t?.function?.name));
          const filteredModel = toolsCompactEnabled ? compactToolsForModel(filteredAll, toolsCompactOpts) : filteredAll;
          if (filteredModel.length > 0) {
            toolsForModel = filteredModel;
            allowedToolNames = new Set(
              toolsForModel.map((t) => t?.function?.name).filter((n) => typeof n === 'string' && n.trim())
            );
            audit.write('tools_selected', { selected, count: filteredModel.length });
          }
        }
      } catch (e) {
        audit.write('tools_selected_error', { error: e?.message || String(e) });
      }
    }

    const steps = [];
    const max = maxSteps ?? this.maxSteps;
    let repairsUsed = 0;
    let lastToolSig = null;
    let repeatedToolStreak = 0;
    let lastExecutedTool = null; // { name, arguments, result }
    let didToolsFallback = false;

    for (let i = 0; i < max; i += 1) {
      if (signal?.aborted) throw signal.reason || new Error('aborted');
      const startedAt = nowMs();
      const extraBody = {};
      if (this.llmConfig.extraBody && typeof this.llmConfig.extraBody === 'object') {
        Object.assign(extraBody, this.llmConfig.extraBody);
      }
      if (this.llmConfig.responseFormat && typeof this.llmConfig.responseFormat === 'object') {
        // OpenAI-compatible JSON mode / JSON schema mode.
        extraBody.response_format = this.llmConfig.responseFormat;
      }

      let llmOut = null;
      while (true) {
        try {
          llmOut = await this.llmClient.chatCompletions({
            messages: session.messages,
            tools: toolsForModel,
            toolChoice: 'auto',
            maxTokens: this.llmConfig.maxTokens,
            temperature: this.llmConfig.temperature,
            topP: this.llmConfig.topP,
            topK: this.llmConfig.topK,
            minP: this.llmConfig.minP,
            repetitionPenalty: this.llmConfig.repetitionPenalty,
            extraBody: Object.keys(extraBody).length > 0 ? extraBody : null,
            signal,
          });
          break;
        } catch (err) {
          // Context-limit fallback: if the model rejects the request due to input tokens, retry once
          // with a best-effort tool selection pass. This is off by default but always used here as
          // a last resort, without requiring config changes.
          if (!didToolsFallback && toolsForModel === toolsForModelAll && isContextLimitError(err)) {
            didToolsFallback = true;
            try {
              const selected = await this._selectToolNamesForPrompt(p, {
                allTools: toolsAll,
                maxTools: this.llmConfig?.toolsSelectMaxTools ?? 16,
                signal,
              });
              if (Array.isArray(selected) && selected.length > 0) {
                const keep = new Set(selected);
                const filteredAll = toolsAll.filter((t) => keep.has(t?.function?.name));
                const filteredModel = toolsCompactEnabled ? compactToolsForModel(filteredAll, toolsCompactOpts) : filteredAll;
                if (filteredModel.length > 0) {
                  toolsForModel = filteredModel;
                  allowedToolNames = new Set(
                    toolsForModel.map((t) => t?.function?.name).filter((n) => typeof n === 'string' && n.trim())
                  );
                  audit.write('tools_selected_fallback', { selected, count: filteredModel.length });
                  continue; // retry LLM call with smaller tool list
                }
              }
            } catch (e) {
              audit.write('tools_selected_fallback_error', { error: e?.message || String(e) });
            }
          }
          throw err;
        }
      }

      // Some servers/models don't emit tool_calls reliably. If the assistant content contains a
      // structured tool call JSON object ({name,arguments}), treat it as a tool call.
      if ((!Array.isArray(llmOut.toolCalls) || llmOut.toolCalls.length === 0) && llmOut.content) {
        const fallback = extractToolCallFromText(llmOut.content, { allowedNames: allowedToolNames });
        if (fallback) {
          // Synthesize a real OpenAI-style tool_calls message so the model reliably
          // receives the tool result in the next turn (tool_call_id correlation).
          const toolCallId = fallback.id && String(fallback.id).trim() ? String(fallback.id).trim() : randomUUID();
          fallback.id = toolCallId;
          llmOut.toolCalls = [fallback];
          llmOut.message = {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: toolCallId,
                type: 'function',
                function: {
                  name: fallback.name,
                  arguments: fallback.argumentsRaw || safeJsonStringify(fallback.arguments || {}),
                },
              },
            ],
          };
        }
      }

      const llmStep = {
        type: 'llm',
        i,
        started_at: startedAt,
        duration_ms: nowMs() - startedAt,
        finish_reason: llmOut.finishReason,
        content: llmOut.content || '',
        tool_calls: llmOut.toolCalls,
      };
      steps.push(llmStep);
      audit.write('llm_response', llmStep);
      if (typeof emit === 'function') await emit(llmStep);

      // If there are tool calls, execute them, append tool results, and loop.
      if (Array.isArray(llmOut.toolCalls) && llmOut.toolCalls.length > 0) {
        // Loop breaker: some models get stuck emitting the same tool call forever.
        // If we see the exact same non-polling tool call repeated many times, return
        // the last executed tool result to the caller.
        if (llmOut.toolCalls.length === 1) {
          const only = llmOut.toolCalls[0];
          const sig = `${only?.name || ''}\n${stableStringify(only?.arguments || {})}`;
          if (sig && sig === lastToolSig && !isRepeatableTool(only?.name)) repeatedToolStreak += 1;
          else {
            lastToolSig = sig;
            repeatedToolStreak = 1;
          }
          if (repeatedToolStreak >= 2 && lastExecutedTool && lastExecutedTool.name === only?.name) {
            audit.write('loop_break', {
              i,
              reason: 'repeated_tool_call',
              tool: lastExecutedTool.name,
              arguments: lastExecutedTool.arguments,
              streak: repeatedToolStreak,
            });
            const loopBreak = {
              type: 'loop_break',
              reason: 'repeated_tool_call',
              tool: lastExecutedTool.name,
              arguments: lastExecutedTool.arguments,
              last_result: lastExecutedTool.result,
            };
            if (typeof emit === 'function') await emit(loopBreak);
            return {
              session_id: id,
              content: safeJsonStringify(loopBreak),
              content_json: loopBreak,
              steps,
            };
          }
        } else {
          repeatedToolStreak = 0;
          lastToolSig = null;
        }

        // Preserve the assistant tool-call message in the transcript so the model/server can
        // correlate subsequent tool results. If we don't have a structured message, preserve
        // at least the assistant text (fallback tool-call JSON in content).
        if (llmOut.message && typeof llmOut.message === 'object') {
          session.messages.push(llmOut.message);
        } else {
          session.messages.push({ role: 'assistant', content: llmOut.content || '' });
        }

        for (const call of llmOut.toolCalls) {
          if (signal?.aborted) throw signal.reason || new Error('aborted');
          if (!call || typeof call.name !== 'string') {
            throw new Error('Invalid tool call (missing name)');
          }
          if (call.parseError) {
            throw new Error(`Tool call arguments parse error for ${call.name}: ${call.parseError}`);
          }
          if (!call.arguments || typeof call.arguments !== 'object') {
            throw new Error(`Tool call missing arguments for ${call.name}`);
          }

          const toolStartedAt = nowMs();
          const repairedArgs = repairToolArguments(call.name, call.arguments);
          audit.write('tool_call', { name: call.name, arguments: repairedArgs, dryRun, autoApprove });
          const toolResult = await this.toolExecutor.execute(call.name, repairedArgs, {
            autoApprove,
            dryRun,
            secrets: session.secrets,
          });
          const toolResultForModel = sealToolResultForModel(toolResult, session.secrets);
          lastExecutedTool = { name: call.name, arguments: repairedArgs, result: toolResultForModel };
          const toolStep = {
            type: 'tool',
            name: call.name,
            arguments: repairedArgs,
            started_at: toolStartedAt,
            duration_ms: nowMs() - toolStartedAt,
            result: toolResultForModel,
          };
          steps.push(toolStep);
          audit.write('tool_result', toolStep);
          if (typeof emit === 'function') await emit(toolStep);

          // Append tool result as a message so the model can continue.
          session.messages.push(normalizeToolResponseMessage({ toolFormat, toolCall: call, result: toolResultForModel }));
        }
        continue;
      }

      // Otherwise, we have a final assistant message.
      const rawFinal = llmOut.content || '';
      const parsed = safeJsonParse(rawFinal);
      const shape = parsed.ok ? isValidStructuredFinal(parsed.value) : { ok: false, error: parsed.error };
      const contentJson = parsed.ok && shape.ok ? parsed.value : { type: 'message', text: rawFinal.trim() };

      // If the model returned an invalid structured output (eg, a plan JSON object) and did not
      // emit a tool call, ask it to re-emit valid JSON. This is the main guardrail that makes
      // "forced structured output" usable with weaker models.
      if ((!parsed.ok || !shape.ok) && repairsUsed < this.maxRepairs) {
        repairsUsed += 1;
        audit.write('repair', {
          i,
          repairs_used: repairsUsed,
          parsed_ok: Boolean(parsed.ok),
          structured_ok: Boolean(parsed.ok && shape.ok),
          structured_error: parsed.ok && !shape.ok ? shape.error : parsed.ok ? null : parsed.error,
        });
        session.messages.push({
          role: 'user',
          content:
            'INVALID_OUTPUT. Output ONLY one of:\n' +
            '1) Tool call JSON: {"type":"tool","name":"<tool_name>","arguments":{...}}\n' +
            '2) Final JSON: {"type":"message","text":"..."}\n' +
            'Do NOT output plans or any other keys. Re-emit now.',
        });
        continue;
      }

      if (llmOut.message && typeof llmOut.message === 'object') session.messages.push(llmOut.message);
      audit.write('final', {
        content: rawFinal,
        structured_ok: Boolean(parsed.ok && shape.ok),
        structured_error: parsed.ok && !shape.ok ? shape.error : parsed.ok ? null : parsed.error,
        content_json: contentJson,
      });
      if (typeof emit === 'function') {
        await emit({
          type: 'final',
          session_id: id,
          content: rawFinal,
          content_json: contentJson,
          steps: steps.length,
          structured_ok: Boolean(parsed.ok && shape.ok),
          structured_error: parsed.ok && !shape.ok ? shape.error : parsed.ok ? null : parsed.error,
        });
      }
      return { session_id: id, content: rawFinal, content_json: contentJson, steps };
    }

    throw new Error(`Max steps exceeded (${max})`);
  }
}
