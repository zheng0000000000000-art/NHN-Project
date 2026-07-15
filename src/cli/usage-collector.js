import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { open, readFile, readdir, stat, writeFile, mkdir, rename, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { cliHome } from './session.js';

const CURSOR_VERSION = 1;

export async function collectUsageSnapshots({
  now = new Date(),
  homeDirectory = os.homedir(),
  queryCodex = queryCodexAppServer,
  includeInitialBackfill = false,
} = {}) {
  const home = cliHome();
  await mkdir(home, { recursive: true, mode: 0o700 });
  const cursorPath = path.join(home, 'usage-cursor.json');
  const cursor = await readJsonSafe(cursorPath, { schemaVersion: CURSOR_VERSION, lastPushAt: null, files: {} });
  cursor.files ??= {};
  const nextCursor = structuredClone(cursor);
  const diagnostics = [];
  const baselineSessionLogs = !includeInitialBackfill && !validIso(cursor.lastPushAt);
  const windowStart = validIso(cursor.lastPushAt) || new Date(now.getTime() - 5 * 60_000).toISOString();
  const windowEnd = now.toISOString();
  const machineId = machineHash(os.hostname());
  const byTool = { 'claude-code': {}, codex: {} };
  const otelTools = new Set();

  await collectSource('otel', async () => {
    const file = path.join(home, 'otel-usage.jsonl');
    const { rows, cursorValue } = await readNewJsonLines(file, cursor.files[file]);
    nextCursor.files[file] = cursorValue;
    for (const row of rows) {
      if (row.tool === 'claude-code' || row.tool === 'codex') otelTools.add(row.tool);
      addUsage(byTool[row.tool] ?? (byTool.other ??= {}), row.model || 'unknown', row.usage || {});
    }
  }, diagnostics);

  await collectSource('claude-session-log', async () => {
    if (otelTools.has('claude-code')) return;
    const files = await walkJsonl(path.join(homeDirectory, '.claude', 'projects'));
    for (const file of files) {
      const { rows, cursorValue, baselined } = await readNewJsonLines(file, cursor.files[file], { baselineOnly: baselineSessionLogs });
      nextCursor.files[file] = cursorValue;
      if (baselined) diagnostics.push({ source: 'claude-session-log', status: 'BASELINED', file });
      for (const value of rows) {
        const parsed = parseClaudeSessionLine(value);
        if (parsed) addUsage(byTool['claude-code'], parsed.model, parsed.usage);
      }
    }
  }, diagnostics);

  await collectSource('codex-session-log', async () => {
    if (otelTools.has('codex')) return;
    const files = await walkJsonl(path.join(homeDirectory, '.codex', 'sessions'));
    for (const file of files) {
      const { rows, cursorValue, baselined } = await readNewJsonLines(file, cursor.files[file], { baselineOnly: baselineSessionLogs });
      nextCursor.files[file] = cursorValue;
      if (baselined) diagnostics.push({ source: 'codex-session-log', status: 'BASELINED', file });
      for (const value of rows) {
        const parsed = parseCodexSessionLine(value);
        if (parsed) addUsage(byTool.codex, parsed.model, parsed.usage);
      }
    }
  }, diagnostics);

  let claudeQuota = null;
  await collectSource('claude-statusline', async () => {
    const value = await readJsonSafe(path.join(home, 'claude-quota.json'), null);
    if (value?.windows?.length) claudeQuota = { source: 'statusline-stdin', windows: value.windows };
  }, diagnostics);

  let codexQuota = null;
  await collectSource('codex-app-server', async () => {
    const value = await queryCodex({ timeoutMs: 8_000 });
    if (value?.windows?.length) codexQuota = { source: 'codex-app-server', windows: value.windows };
  }, diagnostics);

  const snapshots = [];
  for (const tool of ['claude-code', 'codex']) {
    const byModel = byTool[tool];
    const quota = tool === 'claude-code' ? claudeQuota : codexQuota;
    if (Object.keys(byModel).length === 0 && !quota) continue;
    snapshots.push({
      schemaVersion: 1,
      collectedAt: windowEnd,
      tool,
      machineId,
      tokens: Object.keys(byModel).length ? {
        windowStart,
        windowEnd,
        windowId: windowHash(tool, machineId, windowStart, windowEnd, byModel),
        byModel,
      } : null,
      quota,
    });
  }
  nextCursor.lastPushAt = windowEnd;
  return { snapshots, cursorPath, nextCursor, diagnostics };
}

export async function commitUsageCursor(cursorPath, cursor) {
  await atomicWritePrivate(cursorPath, cursor);
}

export async function captureClaudeStatusline(inputText) {
  const value = JSON.parse(inputText);
  const windows = [];
  const mappings = [
    ['five_hour', 'five-hour', '5시간', 300],
    ['seven_day', 'seven-day', '7일', 10080],
  ];
  for (const [sourceKey, windowId, label, duration] of mappings) {
    const source = value?.rate_limits?.[sourceKey];
    if (!source || source.used_percentage == null) continue;
    windows.push({
      limitId: 'claude-code', windowId, label,
      usedPercent: clamp(Number(source.used_percentage) || 0, 0, 100),
      windowDurationMinutes: duration,
      resetsAt: source.resets_at == null ? null : new Date(Number(source.resets_at) * 1000).toISOString(),
    });
  }
  const target = path.join(cliHome(), 'claude-quota.json');
  await atomicWritePrivate(target, { schemaVersion: 1, collectedAt: new Date().toISOString(), windows });
  return { path: target, windows };
}

export async function queryCodexAppServer({ timeoutMs = 8_000, spawnImpl = spawn } = {}) {
  const proc = spawnCodexAppServer(spawnImpl);
  const spawnReady = new Promise((resolve, reject) => {
    proc.once('spawn', resolve);
    proc.once('error', reject);
  });
  const rl = readline.createInterface({ input: proc.stdout });
  const pending = new Map();
  let fatal = null;
  rl.on('line', (line) => {
    try {
      const message = JSON.parse(line);
      if (message.id != null && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message || 'Codex app-server error'));
        else resolve(message.result);
      }
    } catch (error) {
      fatal = error;
    }
  });
  const request = (id, method, params = undefined) => new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    proc.stdin.write(`${JSON.stringify({ method, id, ...(params === undefined ? {} : { params }) })}\n`);
  });
  const timer = setTimeout(() => {
    for (const { reject } of pending.values()) reject(new Error('Codex app-server query timed out.'));
    pending.clear();
    proc.kill('SIGTERM');
  }, timeoutMs);
  try {
    await spawnReady;
    await request(1, 'initialize', { clientInfo: { name: 'team_loop_lite', title: 'Team Loop Lite', version: '0.7.0' } });
    proc.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    const result = await request(2, 'account/rateLimits/read');
    if (fatal) throw fatal;
    const buckets = result?.rateLimitsByLimitId || (result?.rateLimits ? { [result.rateLimits.limitId || 'codex']: result.rateLimits } : {});
    const windows = [];
    for (const [limitId, bucket] of Object.entries(buckets)) {
      for (const key of ['primary', 'secondary']) {
        const window = bucket?.[key];
        if (!window) continue;
        windows.push({
          limitId,
          windowId: key,
          label: bucket.limitName || `${limitId} ${key}`,
          usedPercent: clamp(Number(window.usedPercent) || 0, 0, 100),
          windowDurationMinutes: Math.max(0, Math.round(Number(window.windowDurationMins) || 0)),
          resetsAt: window.resetsAt == null ? null : new Date(Number(window.resetsAt) * 1000).toISOString(),
        });
      }
    }
    return { windows };
  } finally {
    clearTimeout(timer);
    rl.close();
    proc.kill('SIGTERM');
  }
}

function spawnCodexAppServer(spawnImpl) {
  if (process.platform === 'win32' && spawnImpl === spawn) {
    return spawnImpl(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'codex.cmd app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
  }
  return spawnImpl('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
}

export function parseClaudeSessionLine(value) {
  const usage = value?.message?.usage || value?.response?.usage || value?.usage || value?.data?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const model = String(value?.message?.model || value?.response?.model || value?.model || value?.data?.model || 'unknown');
  return { model, usage: normalizeCollectorUsage(usage) };
}

export function parseCodexSessionLine(value) {
  const payload = value?.payload || value?.data || value;
  const eventType = String(payload?.type || value?.type || '');
  const usage = payload?.info?.last_token_usage
    || payload?.last_token_usage
    || (eventType.includes('token') ? payload?.usage : null)
    || value?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const model = String(payload?.model || value?.model || 'codex');
  return { model, usage: normalizeCollectorUsage(usage) };
}

function normalizeCollectorUsage(value) {
  const inputTokens = nonNegative(value.inputTokens ?? value.input_tokens);
  const inputCachedTokens = Math.min(inputTokens, nonNegative(value.inputCachedTokens ?? value.cached_input_tokens ?? value.cache_read_tokens ?? value.cache_read_input_tokens));
  const outputTokens = nonNegative(value.outputTokens ?? value.output_tokens);
  const reasoningTokens = nonNegative(value.reasoningTokens ?? value.reasoning_output_tokens ?? value.reasoning_tokens);
  return {
    inputTokens, inputCachedTokens, outputTokens, reasoningTokens,
    totalTokens: nonNegative(value.totalTokens ?? value.total_tokens) || inputTokens + outputTokens,
  };
}

async function readNewJsonLines(file, cursorValue = null, { baselineOnly = false } = {}) {
  let info;
  try { info = await stat(file); } catch (error) {
    if (error?.code === 'ENOENT') return { rows: [], cursorValue: cursorValue || { offset: 0 } };
    throw error;
  }
  if (baselineOnly && !cursorValue) {
    return { rows: [], cursorValue: { offset: info.size, mtimeMs: info.mtimeMs }, baselined: info.size > 0 };
  }
  let offset = Math.max(0, Number(cursorValue?.offset) || 0);
  if (offset > info.size) offset = 0;
  const handle = await open(file, 'r');
  try {
    const length = info.size - offset;
    if (length <= 0) return { rows: [], cursorValue: { offset: info.size, mtimeMs: info.mtimeMs } };
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    const text = buffer.toString('utf8');
    const complete = text.endsWith('\n');
    const lines = text.split(/\r?\n/);
    if (!complete) lines.pop();
    const consumedText = complete ? text : `${lines.join('\n')}${lines.length ? '\n' : ''}`;
    const rows = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* defensive skip */ }
    }
    return { rows, cursorValue: { offset: offset + Buffer.byteLength(consumedText), mtimeMs: info.mtimeMs } };
  } finally {
    await handle.close();
  }
}

async function walkJsonl(root) {
  const result = [];
  async function walk(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) result.push(target);
    }
  }
  await walk(root);
  return result.sort();
}

function addUsage(byModel, model, usage) {
  const key = String(model || 'unknown');
  const current = byModel[key] ??= { inputTokens: 0, inputCachedTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
  for (const field of Object.keys(current)) current[field] += nonNegative(usage[field]);
}

async function collectSource(source, work, diagnostics) {
  try { await work(); } catch (error) { diagnostics.push({ source, status: 'FAILED', error: String(error.message || error).slice(0, 300) }); }
}

async function readJsonSafe(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return structuredClone(fallback);
    throw error;
  }
}

async function atomicWritePrivate(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(temporary, 0o600).catch(() => {});
  await rename(temporary, file);
  await chmod(file, 0o600).catch(() => {});
}

function machineHash(value) { return createHash('sha256').update(String(value)).digest('hex').slice(0, 24); }
function windowHash(tool, machineId, start, end, byModel) { return createHash('sha256').update(JSON.stringify({ tool, machineId, start, end, byModel })).digest('hex'); }
function validIso(value) { const time = Date.parse(String(value || '')); return Number.isFinite(time) ? new Date(time).toISOString() : null; }
function nonNegative(value) { return Math.max(0, Math.round(Number(value) || 0)); }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
