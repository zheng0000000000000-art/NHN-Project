import os from 'node:os';
import path from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import { HttpError, sha256 } from './utils.js';

const MAX_SESSION_BYTES = 25 * 1024 * 1024;
const MAX_MESSAGES = 500;
const MAX_TOOL_OUTPUT = 6_000;

export class AISessionLogStore {
  constructor({ homeDirectory = os.homedir() } = {}) {
    this.root = path.join(homeDirectory, '.codex', 'sessions');
    this.sessions = new Map();
  }

  async list({ limit = 60 } = {}) {
    const files = await walkJsonl(this.root);
    const rows = [];
    for (const file of files) {
      const metadata = await stat(file).catch(() => null);
      if (!metadata?.isFile() || metadata.size > MAX_SESSION_BYTES) continue;
      const summary = await summarizeCodexSession(file, metadata).catch(() => null);
      if (!summary) continue;
      this.sessions.set(summary.id, file);
      rows.push(summary);
    }
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, Math.max(1, Math.min(200, Number(limit) || 60)));
  }

  async get(id) {
    const safeId = String(id || '').trim();
    let file = this.sessions.get(safeId);
    if (!file) {
      await this.list({ limit: 200 });
      file = this.sessions.get(safeId);
    }
    if (!file) throw new HttpError(404, 'AI session not found.');
    const metadata = await stat(file).catch(() => null);
    if (!metadata?.isFile() || metadata.size > MAX_SESSION_BYTES) throw new HttpError(413, 'AI session is too large to display.');
    return parseCodexSession(await readFile(file, 'utf8'), { id: safeId, updatedAt: metadata.mtime.toISOString() });
  }
}

export function parseCodexSession(content, defaults = {}) {
  const messages = [];
  const toolCalls = new Map();
  let meta = {};
  for (const line of String(content || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const payload = row?.payload || {};
    if (row.type === 'session_meta') {
      meta = {
        sessionId: payload.id || payload.session_id || defaults.id,
        cwd: payload.cwd || '',
        modelProvider: payload.model_provider || '',
        startedAt: payload.timestamp || row.timestamp || null,
      };
      continue;
    }
    if (row.type === 'event_msg' && payload.type === 'user_message') {
      pushMessage(messages, { role: 'user', content: payload.message, at: row.timestamp });
      continue;
    }
    if (row.type === 'event_msg' && payload.type === 'agent_message') {
      pushMessage(messages, { role: 'assistant', phase: payload.phase || 'assistant', content: payload.message, at: row.timestamp });
      continue;
    }
    if (row.type === 'response_item' && ['custom_tool_call', 'function_call'].includes(payload.type)) {
      const callId = payload.call_id || payload.id;
      const message = {
        role: 'tool', kind: 'call', toolName: payload.name || 'tool', callId,
        content: normalizeToolInput(payload.input ?? payload.arguments), at: row.timestamp,
      };
      toolCalls.set(callId, message);
      pushMessage(messages, message);
      continue;
    }
    if (row.type === 'response_item' && ['custom_tool_call_output', 'function_call_output'].includes(payload.type)) {
      const parent = toolCalls.get(payload.call_id);
      pushMessage(messages, {
        role: 'tool', kind: 'output', toolName: parent?.toolName || 'tool', callId: payload.call_id,
        content: truncate(redactSecrets(normalizeToolOutput(payload.output)), MAX_TOOL_OUTPUT), at: row.timestamp,
        truncated: normalizeToolOutput(payload.output).length > MAX_TOOL_OUTPUT,
      });
    }
  }
  const visible = messages.slice(-MAX_MESSAGES);
  const answerMessages = visible.filter((message) => message.role === 'user' || (message.role === 'assistant' && message.phase === 'final_answer'));
  const firstUser = visible.find((message) => message.role === 'user');
  return {
    id: defaults.id || stableSessionId(meta.sessionId || ''),
    source: 'codex',
    title: compactTitle(firstUser?.content || 'Codex session'),
    cwd: meta.cwd,
    modelProvider: meta.modelProvider,
    startedAt: meta.startedAt,
    updatedAt: defaults.updatedAt || visible.at(-1)?.at || meta.startedAt,
    messageCount: visible.length,
    answerCount: answerMessages.length,
    truncated: messages.length > MAX_MESSAGES,
    messages: visible,
  };
}

async function summarizeCodexSession(file, metadata) {
  const content = await readFile(file, 'utf8');
  const parsed = parseCodexSession(content, { id: stableSessionId(file), updatedAt: metadata.mtime.toISOString() });
  if (!parsed.messages.some((message) => message.role === 'user' || message.role === 'assistant')) return null;
  const { messages, ...summary } = parsed;
  return summary;
}

function pushMessage(messages, input) {
  const content = redactSecrets(String(input.content || '').trim());
  if (!content) return;
  messages.push({ id: `msg_${sha256(`${input.at || ''}|${messages.length}|${content}`).slice(0, 16)}`, ...input, content });
}

function normalizeToolInput(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value ?? {}, null, 2); } catch { return String(value ?? ''); }
}

function normalizeToolOutput(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.output === 'string') return value.output;
  try { return JSON.stringify(value ?? {}, null, 2); } catch { return String(value ?? ''); }
}

function redactSecrets(value) {
  return String(value || '')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED_API_KEY]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s,;"']+/gi, '$1[REDACTED]');
}

function truncate(value, max) { return String(value || '').slice(0, max); }
function compactTitle(value) { return String(value || '').replace(/\s+/g, ' ').slice(0, 100); }
function stableSessionId(value) { return `ais_${sha256(value).slice(0, 20)}`; }

async function walkJsonl(root) {
  const output = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) output.push(target);
    }
  }
  await visit(root);
  return output;
}
