import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { UsageTracker, normalizeUsage } from '../src/usage.js';

test('normalizes Responses API token usage', () => {
  assert.deepEqual(normalizeUsage({
    input_tokens: 120,
    input_tokens_details: { cached_tokens: 20 },
    output_tokens: 30,
    output_tokens_details: { reasoning_tokens: 12 },
    total_tokens: 150,
  }), {
    inputTokens: 120,
    inputCachedTokens: 20,
    outputTokens: 30,
    reasoningTokens: 12,
    totalTokens: 150,
  });
});

test('usage tracker aggregates by user, source, feature and budget', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-usage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'usage.json');
  await writeFile(configPath, JSON.stringify({
    timeZone: 'Asia/Seoul',
    monthlyTokenBudget: 1000,
    monthlyRequestBudget: 10,
    monthlyCostBudgetUsd: 10,
    modelPricingUsdPerMillionTokens: {
      'test-model': { input: 2, cachedInput: 1, output: 8 },
    },
  }));
  const tracker = new UsageTracker({ dataDirectory: path.join(root, 'data'), configPath });
  await tracker.initialize();
  await tracker.record({
    actorUserId: 'usr_a', feature: 'task-draft', model: 'test-model', source: 'cli',
    usage: { inputTokens: 100, inputCachedTokens: 25, outputTokens: 50, totalTokens: 150 },
    durationMs: 200,
    context: { selectedTokens: 900, sourceCount: 4, indexedTokens: 90_000 },
  });
  await tracker.record({
    actorUserId: 'usr_b', feature: 'task-brief', model: 'test-model', source: 'web',
    usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
    durationMs: 400,
  });
  const summary = await tracker.summary({ days: 7, users: [
    { id: 'usr_a', name: 'Alice', role: 'admin' },
    { id: 'usr_b', name: 'Bob', role: 'member' },
  ] });
  assert.equal(summary.totals.requests, 2);
  assert.equal(summary.totals.totalTokens, 425);
  assert.equal(summary.totals.inputCachedTokens, 25);
  assert.equal(summary.budget.tokens.percent, 42.5);
  assert.equal(summary.byUser[0].name, 'Bob');
  assert.equal(summary.bySource.find((item) => item.source === 'cli').requests, 1);
  assert.equal(summary.byFeature.find((item) => item.feature === 'task-draft').totalTokens, 125);
  assert.equal(summary.recent.length, 2);
  assert.equal(summary.totals.pricedRequests, 2);
  assert.ok(summary.totals.estimatedCostUsd > 0);
  assert.equal(summary.context.requests, 1);
  assert.equal(summary.context.averageSelectedTokens, 900);
  assert.equal(summary.context.sourceChunks, 4);
  assert.equal(summary.context.selectionRate, 0.01);
});

test('usage summary can be limited to the current actor', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-usage-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'usage.json');
  await writeFile(configPath, JSON.stringify({ timeZone: 'Asia/Seoul' }));
  const tracker = new UsageTracker({ dataDirectory: path.join(root, 'data'), configPath });
  await tracker.initialize();
  await tracker.record({
    actorUserId: 'usr_a', feature: 'task-draft', model: 'test-model', source: 'cli',
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  });
  await tracker.record({
    actorUserId: 'usr_b', feature: 'task-brief', model: 'test-model', source: 'web',
    usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
  });

  const summary = await tracker.summary({
    days: 7,
    users: [{ id: 'usr_b', name: 'Bob', role: 'member' }],
    actorUserIds: ['usr_b'],
  });

  assert.equal(summary.totals.requests, 1);
  assert.equal(summary.totals.totalTokens, 10);
  assert.deepEqual(summary.byUser.map((item) => item.userId), ['usr_b']);
  assert.equal(summary.recent.length, 1);
  assert.equal(summary.recent[0].actorUserId, 'usr_b');
});

test('usage summary caches 10k parsed events and invalidates on external append', async (t) => {
  const { performance } = await import('node:perf_hooks');
  const { mkdir, appendFile } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-usage-perf-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDirectory = path.join(root, 'data');
  await mkdir(dataDirectory, { recursive: true });
  const configPath = path.join(root, 'usage.json');
  await writeFile(configPath, JSON.stringify({ timeZone: 'Asia/Seoul' }));
  const at = new Date().toISOString();
  const events = Array.from({ length: 10_000 }, (_, index) => JSON.stringify({
    eventId: `event-${index}`,
    at,
    actorUserId: `usr_${index % 3}`,
    feature: 'task-brief',
    model: 'test-model',
    source: 'cli',
    status: 'SUCCESS',
    durationMs: 1,
    usage: { inputTokens: 1, inputCachedTokens: 0, outputTokens: 1, reasoningTokens: 0, totalTokens: 2 },
    estimatedCostUsd: null,
  }));
  const eventsPath = path.join(dataDirectory, 'ai-usage.jsonl');
  await writeFile(eventsPath, `${events.join('\n')}\n`);

  const tracker = new UsageTracker({ dataDirectory, configPath });
  await tracker.initialize();
  const coldStarted = performance.now();
  const cold = await tracker.summary({ days: 30 });
  const coldMs = performance.now() - coldStarted;

  const warmDurations = [];
  for (let index = 0; index < 5; index += 1) {
    const started = performance.now();
    await tracker.summary({ days: 30 });
    warmDurations.push(performance.now() - started);
  }
  warmDurations.sort((a, b) => a - b);
  const warmMedianMs = warmDurations[Math.floor(warmDurations.length / 2)];
  assert.equal(cold.totals.requests, 10_000);
  assert.ok(coldMs < 100, `cold summary took ${coldMs.toFixed(1)}ms`);
  assert.ok(warmMedianMs < 10, `warm summary median took ${warmMedianMs.toFixed(1)}ms`);

  await appendFile(eventsPath, `${JSON.stringify({
    eventId: 'external-event', at, actorUserId: 'usr_external', feature: 'task-draft', model: 'test-model', source: 'api', status: 'SUCCESS', durationMs: 1,
    usage: { inputTokens: 1, inputCachedTokens: 0, outputTokens: 1, reasoningTokens: 0, totalTokens: 2 }, estimatedCostUsd: null,
  })}\n`);
  const refreshed = await tracker.summary({ days: 30 });
  assert.equal(refreshed.totals.requests, 10_001);
});
