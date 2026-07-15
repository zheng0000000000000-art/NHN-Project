import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { appendJsonLine, ensureDir, nowIso, randomId, readJson } from './utils.js';

const DATE_FORMATTERS = new Map();
const EVENT_DATE_KEY = Symbol('usageDateKey');

const EMPTY_CONFIG = {
  schemaVersion: 1,
  timeZone: 'Asia/Seoul',
  monthlyTokenBudget: 0,
  monthlyRequestBudget: 0,
  monthlyCostBudgetUsd: 0,
  modelPricingUsdPerMillionTokens: {},
};

export class UsageTracker {
  constructor({ dataDirectory, configPath }) {
    this.dataDirectory = dataDirectory;
    this.eventsPath = path.join(dataDirectory, 'ai-usage.jsonl');
    this.configPath = configPath;
    this.config = structuredClone(EMPTY_CONFIG);
    this.lock = Promise.resolve();
    this.eventCache = null;
  }

  async initialize() {
    await ensureDir(this.dataDirectory);
    const fileConfig = await readJson(this.configPath, EMPTY_CONFIG);
    this.config = normalizeConfig({ ...EMPTY_CONFIG, ...fileConfig });
    applyEnvironmentOverrides(this.config);
  }

  status() {
    return {
      scope: 'TEAM_LOOP_AI_CALLS_ONLY',
      timeZone: this.config.timeZone,
      tokenBudgetConfigured: this.config.monthlyTokenBudget > 0,
      requestBudgetConfigured: this.config.monthlyRequestBudget > 0,
      costBudgetConfigured: this.config.monthlyCostBudgetUsd > 0,
      pricingConfiguredModels: Object.keys(this.config.modelPricingUsdPerMillionTokens),
    };
  }

  async record({ actorUserId, feature, model, source = 'api', status = 'SUCCESS', usage = {}, providerRequestId = null, durationMs = 0, error = null }) {
    const normalizedUsage = normalizeUsage(usage);
    const estimatedCostUsd = normalizedUsage.totalTokens > 0
      ? estimateCost(model, normalizedUsage, this.config.modelPricingUsdPerMillionTokens)
      : null;
    const event = {
      eventId: randomId('use_'),
      at: nowIso(),
      actorUserId,
      feature: String(feature || 'unknown'),
      model: String(model || 'unknown'),
      source: normalizeSource(source),
      status: status === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
      providerRequestId: providerRequestId || null,
      durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
      usage: normalizedUsage,
      estimatedCostUsd,
      error: error ? String(error).slice(0, 500) : null,
    };
    return this.#withLock(async () => {
      const before = await fileMetadata(this.eventsPath);
      const canExtendCache = this.eventCache
        && metadataEqual(this.eventCache, before);
      await appendJsonLine(this.eventsPath, event);
      const after = await fileMetadata(this.eventsPath);
      if (canExtendCache) {
        this.#attachDateKey(event);
        this.eventCache.events.push(event);
        this.eventCache.exists = after.exists;
        this.eventCache.size = after.size;
        this.eventCache.mtimeMs = after.mtimeMs;
      } else {
        this.eventCache = null;
      }
      return event;
    });
  }

  async summary({ days = 30, users = [] } = {}) {
    const safeDays = [7, 30, 90].includes(Number(days)) ? Number(days) : 30;
    const events = await this.#readEvents();
    const now = new Date();
    const cutoff = now.getTime() - safeDays * 24 * 60 * 60 * 1000;
    const periodEvents = events.filter((event) => Date.parse(event.at) >= cutoff);
    const monthKey = dateKey(now, this.config.timeZone).slice(0, 7);
    const monthEvents = events.filter((event) => event[EVENT_DATE_KEY].startsWith(monthKey));
    const userMap = new Map(users.map((user) => [user.id, user]));

    const totals = aggregate(periodEvents);
    const monthlyTotals = aggregate(monthEvents);
    const budget = {
      month: monthKey,
      tokens: budgetMetric(monthlyTotals.totalTokens, this.config.monthlyTokenBudget),
      requests: budgetMetric(monthlyTotals.requests, this.config.monthlyRequestBudget),
      costUsd: budgetMetric(monthlyTotals.estimatedCostUsd, this.config.monthlyCostBudgetUsd),
    };

    return {
      generatedAt: nowIso(),
      scope: {
        code: 'TEAM_LOOP_AI_CALLS_ONLY',
        description: 'Team Loop 서버를 통해 실행된 AI 요청만 집계합니다. 별도 Codex/ChatGPT 앱 사용량은 포함하지 않습니다.',
      },
      period: {
        days: safeDays,
        from: new Date(cutoff).toISOString(),
        to: now.toISOString(),
        timeZone: this.config.timeZone,
      },
      totals,
      monthlyTotals,
      budget,
      daily: buildDaily(periodEvents, safeDays, this.config.timeZone),
      byUser: groupAggregate(periodEvents, (event) => event.actorUserId).map((entry) => ({
        ...entry,
        userId: entry.key,
        name: userMap.get(entry.key)?.name || '알 수 없는 사용자',
        role: userMap.get(entry.key)?.role || null,
      })).sort(sortByTokens),
      byFeature: groupAggregate(periodEvents, (event) => event.feature).map(renameKey('feature')).sort(sortByTokens),
      byModel: groupAggregate(periodEvents, (event) => event.model).map(renameKey('model')).sort(sortByTokens),
      bySource: groupAggregate(periodEvents, (event) => event.source).map(renameKey('source')).sort(sortByTokens),
      recent: [...periodEvents].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40).map((event) => ({
        ...event,
        actorName: userMap.get(event.actorUserId)?.name || '알 수 없음',
      })),
      config: {
        monthlyTokenBudget: this.config.monthlyTokenBudget,
        monthlyRequestBudget: this.config.monthlyRequestBudget,
        monthlyCostBudgetUsd: this.config.monthlyCostBudgetUsd,
        pricingConfiguredModels: Object.keys(this.config.modelPricingUsdPerMillionTokens),
      },
    };
  }

  async #readEvents() {
    const metadata = await fileMetadata(this.eventsPath);
    if (this.eventCache && metadataEqual(this.eventCache, metadata)) return this.eventCache.events;
    if (!metadata.exists) {
      this.eventCache = { ...metadata, events: [] };
      return this.eventCache.events;
    }

    // Retry once if another process appends while the file is being read. This project
    // remains single-process by contract, but the cache must still fail safely when an
    // operator edits or restores the JSONL file externally.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = await fileMetadata(this.eventsPath);
      const text = await readFile(this.eventsPath, 'utf8');
      const after = await fileMetadata(this.eventsPath);
      if (!metadataEqual(before, after) && attempt === 0) continue;
      const events = [];
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const value = JSON.parse(line);
          if (value && typeof value === 'object' && typeof value.at === 'string') {
            this.#attachDateKey(value);
            events.push(value);
          }
        } catch {
          // A malformed line is ignored rather than making the whole dashboard unavailable.
        }
      }
      this.eventCache = { ...after, events };
      return events;
    }
    return [];
  }

  #attachDateKey(event) {
    if (event[EVENT_DATE_KEY]) return event;
    Object.defineProperty(event, EVENT_DATE_KEY, {
      value: dateKey(new Date(event.at), this.config.timeZone),
      enumerable: false,
      configurable: false,
    });
    return event;
  }

  #withLock(work) {
    const result = this.lock.then(work, work);
    this.lock = result.catch(() => {});
    return result;
  }
}

export function normalizeUsage(value = {}) {
  const inputTokens = nonNegative(value.inputTokens ?? value.input_tokens);
  const inputCachedTokens = nonNegative(
    value.inputCachedTokens
      ?? value.input_cached_tokens
      ?? value.input_tokens_details?.cached_tokens,
  );
  const outputTokens = nonNegative(value.outputTokens ?? value.output_tokens);
  const reasoningTokens = nonNegative(
    value.reasoningTokens
      ?? value.reasoning_tokens
      ?? value.output_tokens_details?.reasoning_tokens,
  );
  const suppliedTotal = nonNegative(value.totalTokens ?? value.total_tokens);
  return {
    inputTokens,
    inputCachedTokens: Math.min(inputTokens, inputCachedTokens),
    outputTokens,
    reasoningTokens,
    totalTokens: suppliedTotal || inputTokens + outputTokens,
  };
}

function normalizeConfig(config) {
  const pricing = {};
  for (const [model, value] of Object.entries(config.modelPricingUsdPerMillionTokens ?? {})) {
    pricing[model] = {
      input: nonNegativeNumber(value?.input),
      cachedInput: nonNegativeNumber(value?.cachedInput),
      output: nonNegativeNumber(value?.output),
    };
  }
  return {
    schemaVersion: 1,
    timeZone: validTimeZone(config.timeZone) ? config.timeZone : 'Asia/Seoul',
    monthlyTokenBudget: nonNegativeNumber(config.monthlyTokenBudget),
    monthlyRequestBudget: nonNegativeNumber(config.monthlyRequestBudget),
    monthlyCostBudgetUsd: nonNegativeNumber(config.monthlyCostBudgetUsd),
    modelPricingUsdPerMillionTokens: pricing,
  };
}

function applyEnvironmentOverrides(config) {
  const values = {
    monthlyTokenBudget: process.env.AI_MONTHLY_TOKEN_BUDGET,
    monthlyRequestBudget: process.env.AI_MONTHLY_REQUEST_BUDGET,
    monthlyCostBudgetUsd: process.env.AI_MONTHLY_COST_BUDGET_USD,
  };
  for (const [key, raw] of Object.entries(values)) {
    if (raw !== undefined && raw !== '') config[key] = nonNegativeNumber(raw);
  }
  if (process.env.USAGE_TIME_ZONE && validTimeZone(process.env.USAGE_TIME_ZONE)) {
    config.timeZone = process.env.USAGE_TIME_ZONE;
  }
}

function aggregate(events) {
  const total = {
    requests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    inputTokens: 0,
    inputCachedTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    pricedRequests: 0,
    averageDurationMs: 0,
  };
  let duration = 0;
  for (const event of events) {
    total.requests += 1;
    if (event.status === 'SUCCESS') total.successfulRequests += 1;
    else total.failedRequests += 1;
    total.inputTokens += nonNegative(event.usage?.inputTokens);
    total.inputCachedTokens += nonNegative(event.usage?.inputCachedTokens);
    total.outputTokens += nonNegative(event.usage?.outputTokens);
    total.reasoningTokens += nonNegative(event.usage?.reasoningTokens);
    total.totalTokens += nonNegative(event.usage?.totalTokens);
    if (Number.isFinite(event.estimatedCostUsd)) {
      total.estimatedCostUsd += event.estimatedCostUsd;
      total.pricedRequests += 1;
    }
    duration += nonNegative(event.durationMs);
  }
  total.estimatedCostUsd = roundCurrency(total.estimatedCostUsd);
  total.averageDurationMs = total.requests ? Math.round(duration / total.requests) : 0;
  total.failureRate = total.requests ? total.failedRequests / total.requests : 0;
  total.cacheRate = total.inputTokens ? total.inputCachedTokens / total.inputTokens : 0;
  return total;
}

function groupAggregate(events, keyOf) {
  const map = new Map();
  for (const event of events) {
    const key = String(keyOf(event) || 'unknown');
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(event);
  }
  return [...map.entries()].map(([key, group]) => ({ key, ...aggregate(group) }));
}

function buildDaily(events, days, timeZone) {
  const byDay = new Map();
  for (const event of events) {
    const key = event[EVENT_DATE_KEY] ?? dateKey(new Date(event.at), timeZone);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(event);
  }
  const result = [];
  const now = Date.now();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(now - offset * 24 * 60 * 60 * 1000);
    const key = dateKey(date, timeZone);
    result.push({ date: key, ...aggregate(byDay.get(key) ?? []) });
  }
  return result;
}

function budgetMetric(used, limit) {
  const configured = Number(limit) > 0;
  const ratio = configured ? used / limit : null;
  return {
    configured,
    used,
    limit: configured ? limit : null,
    remaining: configured ? Math.max(0, limit - used) : null,
    ratio,
    percent: ratio == null ? null : Math.round(ratio * 1000) / 10,
    status: ratio == null ? 'UNCONFIGURED' : ratio >= 1 ? 'EXCEEDED' : ratio >= 0.85 ? 'CRITICAL' : ratio >= 0.65 ? 'WARNING' : 'OK',
  };
}

function estimateCost(model, usage, pricingByModel) {
  const pricing = pricingByModel[model] ?? pricingByModel['*'];
  if (!pricing) return null;
  const cached = Math.min(usage.inputTokens, usage.inputCachedTokens);
  const uncached = Math.max(0, usage.inputTokens - cached);
  return roundCurrency((
    uncached * pricing.input
    + cached * pricing.cachedInput
    + usage.outputTokens * pricing.output
  ) / 1_000_000);
}

function dateKey(date, timeZone) {
  let formatter = DATE_FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    DATE_FORMATTERS.set(timeZone, formatter);
  }
  return formatter.format(date);
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
  return Boolean(left && right)
    && left.exists === right.exists
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function validTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function nonNegative(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

function nonNegativeNumber(value) {
  return Math.max(0, Number(value) || 0);
}

function normalizeSource(value) {
  return ['cli', 'web', 'api'].includes(value) ? value : 'api';
}

function roundCurrency(value) {
  return Math.round((Number(value) || 0) * 1_000_000) / 1_000_000;
}

function renameKey(name) {
  return ({ key, ...rest }) => ({ [name]: key, ...rest });
}

function sortByTokens(a, b) {
  return b.totalTokens - a.totalTokens || b.requests - a.requests;
}
