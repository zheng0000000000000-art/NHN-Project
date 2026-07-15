import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { appendJsonLine, atomicWriteJson, ensureDir, HttpError, nowIso, randomId, readJson, sha256 } from './utils.js';
import { normalizeUsage } from './usage.js';

const TOOL_VALUES = new Set(['claude-code', 'codex', 'other']);
const DEFAULT_STATE = { schemaVersion: 1, streams: {}, quotas: {} };

export class ExternalUsageStore {
  constructor({ dataDirectory, freshnessMs = 15 * 60_000, now = () => new Date() }) {
    this.dataDirectory = dataDirectory;
    this.eventsPath = path.join(dataDirectory, 'external-usage.jsonl');
    this.statePath = path.join(dataDirectory, 'external-quota.json');
    this.freshnessMs = freshnessMs;
    this.now = now;
    this.lock = Promise.resolve();
    this.eventCache = null;
  }

  async initialize() {
    await ensureDir(this.dataDirectory);
    const state = await readJson(this.statePath, DEFAULT_STATE);
    if (!state || state.schemaVersion !== 1) await atomicWriteJson(this.statePath, DEFAULT_STATE);
  }

  async record(actorUserId, input) {
    const snapshot = normalizeExternalSnapshot(input);
    return this.#withLock(async () => {
      const events = await this.#readEvents();
      const duplicate = snapshot.tokens
        ? events.some((event) => event.actorUserId === actorUserId
          && event.tool === snapshot.tool
          && event.machineId === snapshot.machineId
          && event.tokens?.windowId === snapshot.tokens.windowId)
        : false;

      const state = await readJson(this.statePath, DEFAULT_STATE);
      state.streams ??= {};
      state.quotas ??= {};
      const streamKey = keyOf(actorUserId, snapshot.tool, snapshot.machineId);
      let event = null;

      if (snapshot.tokens && !duplicate) {
        const previousEnd = state.streams[streamKey]?.lastWindowEnd;
        if (previousEnd && Date.parse(snapshot.tokens.windowStart) < Date.parse(previousEnd)) {
          throw new HttpError(409, 'Token window overlaps the previously accepted window.', {
            code: 'overlapping-token-window',
            lastWindowEnd: previousEnd,
          });
        }
        event = {
          eventId: randomId('ext_'),
          receivedAt: nowIso(),
          actorUserId,
          ...snapshot,
          quota: undefined,
        };
        await appendJsonLine(this.eventsPath, event);
        state.streams[streamKey] = {
          lastWindowEnd: snapshot.tokens.windowEnd,
          lastWindowId: snapshot.tokens.windowId,
          updatedAt: event.receivedAt,
        };
        this.eventCache = null;
      }

      if (snapshot.quota) {
        state.quotas[streamKey] = {
          actorUserId,
          tool: snapshot.tool,
          machineId: snapshot.machineId,
          collectedAt: snapshot.collectedAt,
          source: snapshot.quota.source,
          windows: snapshot.quota.windows,
        };
      }
      await atomicWriteJson(this.statePath, state);
      return { accepted: Boolean(event), duplicate, snapshot, event };
    });
  }

  async summary({ days = 30, users = [] } = {}) {
    const safeDays = [7, 30, 90].includes(Number(days)) ? Number(days) : 30;
    const now = this.now();
    const cutoff = now.getTime() - safeDays * 24 * 60 * 60 * 1000;
    const userMap = new Map(users.map((user) => [user.id, user]));
    const events = (await this.#readEvents()).filter((event) => Date.parse(event.tokens?.windowEnd || event.receivedAt) >= cutoff);
    const modelRows = [];
    for (const event of events) {
      for (const [model, usage] of Object.entries(event.tokens?.byModel || {})) {
        modelRows.push({
          actorUserId: event.actorUserId,
          tool: event.tool,
          model,
          usage,
          windowStart: event.tokens.windowStart,
          windowEnd: event.tokens.windowEnd,
        });
      }
    }
    const state = await readJson(this.statePath, DEFAULT_STATE);
    const quota = Object.values(state.quotas || {}).map((entry) => ({
      ...entry,
      actorName: userMap.get(entry.actorUserId)?.name || '알 수 없음',
      windows: (entry.windows || []).map((window) => quotaFreshness(window, entry.collectedAt, now, this.freshnessMs)),
    })).sort((a, b) => a.actorName.localeCompare(b.actorName) || a.tool.localeCompare(b.tool));

    return {
      scope: {
        code: 'EXTERNAL_AI_TOOLS_REFERENCE_ONLY',
        description: '외부 Claude Code/Codex 사용량은 참고용 별도 집계이며 Team Loop 서버 경유 예산과 합산하지 않습니다.',
      },
      totals: aggregateRows(modelRows),
      byTool: groupedRows(modelRows, (row) => row.tool, 'tool'),
      byUser: groupedRows(modelRows, (row) => row.actorUserId, 'userId').map((row) => ({
        ...row,
        name: userMap.get(row.userId)?.name || '알 수 없음',
        role: userMap.get(row.userId)?.role || null,
      })),
      byModel: groupedRows(modelRows, (row) => row.model, 'model'),
      daily: buildExternalDaily(modelRows, safeDays),
      quota,
      events: events.length,
    };
  }

  async #readEvents() {
    const metadata = await fileMetadata(this.eventsPath);
    if (this.eventCache && metadataEqual(this.eventCache, metadata)) return this.eventCache.events;
    if (!metadata.exists) {
      this.eventCache = { ...metadata, events: [] };
      return this.eventCache.events;
    }
    const text = await readFile(this.eventsPath, 'utf8');
    const events = [];
    const seen = new Set();
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const identity = `${event.actorUserId}|${event.tool}|${event.machineId}|${event.tokens?.windowId || event.eventId}`;
        if (!seen.has(identity)) {
          seen.add(identity);
          events.push(event);
        }
      } catch {
        // Malformed external collector lines do not take down the dashboard.
      }
    }
    this.eventCache = { ...metadata, events };
    return events;
  }

  #withLock(work) {
    const result = this.lock.then(work, work);
    this.lock = result.catch(() => {});
    return result;
  }
}

export function normalizeExternalSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'External usage snapshot must be an object.');
  if (Number(value.schemaVersion) !== 1) throw new HttpError(400, 'Unsupported external usage schemaVersion.');
  const tool = String(value.tool || '').toLowerCase();
  if (!TOOL_VALUES.has(tool)) throw new HttpError(400, 'Unknown external usage tool.');
  const collectedAt = normalizeIso(value.collectedAt, 'collectedAt');
  const machineId = String(value.machineId || '').trim().slice(0, 200);
  if (!machineId) throw new HttpError(400, 'machineId is required.');
  const tokens = value.tokens == null ? null : normalizeTokenWindow(value.tokens, { tool, machineId });
  const quota = value.quota == null ? null : normalizeQuota(value.quota, tool);
  if (!tokens && !quota) throw new HttpError(400, 'tokens or quota is required.');
  return { schemaVersion: 1, collectedAt, tool, machineId, tokens, quota };
}

function normalizeTokenWindow(value, identity) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'tokens must be an object.');
  const windowStart = normalizeIso(value.windowStart, 'tokens.windowStart');
  const windowEnd = normalizeIso(value.windowEnd, 'tokens.windowEnd');
  if (Date.parse(windowStart) >= Date.parse(windowEnd)) throw new HttpError(400, 'tokens.windowStart must be before windowEnd.');
  const byModel = {};
  for (const [rawModel, rawUsage] of Object.entries(value.byModel || {})) {
    const model = String(rawModel).trim().slice(0, 200);
    if (!model) continue;
    byModel[model] = normalizeUsage(rawUsage);
  }
  if (Object.keys(byModel).length === 0) throw new HttpError(400, 'tokens.byModel must contain at least one model.');
  const canonical = JSON.stringify({ ...identity, windowStart, windowEnd, byModel });
  const windowId = String(value.windowId || sha256(canonical)).slice(0, 200);
  return { windowId, windowStart, windowEnd, byModel };
}

function normalizeQuota(value, tool) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'quota must be an object.');
  const source = String(value.source || 'unknown').slice(0, 100);
  let rawWindows = Array.isArray(value.windows) ? value.windows : [];
  if (rawWindows.length === 0) {
    rawWindows = [
      value.session && { ...value.session, limitId: tool, windowId: 'session', label: 'Session' },
      value.weekly && { ...value.weekly, limitId: tool, windowId: 'weekly', label: 'Weekly' },
    ].filter(Boolean);
  }
  const windows = rawWindows.map((window, index) => normalizeQuotaWindow(window, tool, index));
  if (windows.length === 0) throw new HttpError(400, 'quota.windows must not be empty.');
  return { source, windows };
}

function normalizeQuotaWindow(value, tool, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'quota window must be an object.');
  const usedPercent = clamp(Number(value.usedPercent ?? value.used_percentage) || 0, 0, 100);
  const resetsAt = value.resetsAt ?? value.resets_at;
  return {
    limitId: String(value.limitId || tool).slice(0, 100),
    windowId: String(value.windowId || value.id || `window-${index + 1}`).slice(0, 100),
    label: String(value.label || value.windowId || value.id || `Window ${index + 1}`).slice(0, 100),
    usedPercent,
    windowDurationMinutes: value.windowDurationMinutes == null && value.windowDurationMins == null
      ? null
      : Math.max(0, Math.round(Number(value.windowDurationMinutes ?? value.windowDurationMins) || 0)),
    resetsAt: resetsAt == null ? null : normalizeTimestamp(resetsAt, 'quota.resetsAt'),
  };
}

export function quotaFreshness(window, collectedAt, now = new Date(), freshnessMs = 15 * 60_000) {
  const ageMs = Math.max(0, now.getTime() - Date.parse(collectedAt));
  const lastKnownUsedPercent = clamp(Number(window.usedPercent) || 0, 0, 100);
  if (ageMs <= freshnessMs) return { ...window, freshness: 'LIVE', effectiveUsedPercent: lastKnownUsedPercent, staleSinceMinutes: 0 };
  const staleSinceMinutes = Math.floor(ageMs / 60_000);
  if (window.resetsAt && now.getTime() >= Date.parse(window.resetsAt)) {
    return {
      ...window,
      freshness: 'RESET_INFERRED',
      effectiveUsedPercent: 0,
      inferredUsedPercent: 0,
      lastKnownUsedPercent,
      staleSinceMinutes,
    };
  }
  return { ...window, freshness: 'STALE', effectiveUsedPercent: lastKnownUsedPercent, lastKnownUsedPercent, staleSinceMinutes };
}

function normalizeIso(value, name) {
  const time = Date.parse(String(value || ''));
  if (!Number.isFinite(time)) throw new HttpError(400, `${name} must be an ISO timestamp.`);
  return new Date(time).toISOString();
}

function normalizeTimestamp(value, name) {
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value))) {
    const number = Number(value);
    return normalizeIso(new Date(number < 10_000_000_000 ? number * 1000 : number).toISOString(), name);
  }
  return normalizeIso(value, name);
}

function aggregateRows(rows) {
  const total = { windows: 0, inputTokens: 0, inputCachedTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
  for (const row of rows) {
    total.windows += 1;
    for (const key of ['inputTokens', 'inputCachedTokens', 'outputTokens', 'reasoningTokens', 'totalTokens']) {
      total[key] += Math.max(0, Math.round(Number(row.usage?.[key]) || 0));
    }
  }
  return total;
}

function groupedRows(rows, keyOf, name) {
  const groups = new Map();
  for (const row of rows) {
    const key = String(keyOf(row) || 'unknown');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].map(([key, group]) => ({ [name]: key, ...aggregateRows(group) }))
    .sort((a, b) => b.totalTokens - a.totalTokens || String(a[name]).localeCompare(String(b[name])));
}

function buildExternalDaily(rows, days) {
  const byDay = new Map();
  for (const row of rows) {
    const key = new Date(row.windowEnd).toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(row);
  }
  const result = [];
  const now = Date.now();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(now - offset * 24 * 60 * 60 * 1000);
    const key = date.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    result.push({ date: key, ...aggregateRows(byDay.get(key) ?? []) });
  }
  return result;
}

function keyOf(actorUserId, tool, machineId) {
  return `${actorUserId}|${tool}|${machineId}`;
}

async function fileMetadata(filePath) {
  try {
    const value = await stat(filePath);
    return { exists: true, size: value.size, mtimeMs: value.mtimeMs };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, size: 0, mtimeMs: 0 };
    throw error;
  }
}

function metadataEqual(left, right) {
  return Boolean(left && right) && left.exists === right.exists && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
