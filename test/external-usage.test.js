import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { ExternalUsageStore, normalizeExternalSnapshot, quotaFreshness } from '../src/external-usage.js';

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    collectedAt: '2026-07-15T09:00:00.000Z',
    tool: 'claude-code',
    machineId: 'machine-1',
    tokens: {
      windowId: 'window-1',
      windowStart: '2026-07-15T08:00:00.000Z',
      windowEnd: '2026-07-15T09:00:00.000Z',
      byModel: { 'claude-test': { inputTokens: 100, inputCachedTokens: 20, outputTokens: 50, totalTokens: 150 } },
    },
    quota: {
      source: 'statusline-stdin',
      windows: [{ limitId: 'claude-code', windowId: 'five-hour', usedPercent: 120, resetsAt: '2026-07-15T12:00:00.000Z' }],
    },
    ...overrides,
  };
}

test('external usage schema clamps quota and rejects unknown tools', () => {
  const value = normalizeExternalSnapshot(snapshot());
  assert.equal(value.quota.windows[0].usedPercent, 100);
  assert.equal(value.tokens.byModel['claude-test'].inputCachedTokens, 20);
  assert.throws(() => normalizeExternalSnapshot(snapshot({ tool: 'mystery' })), /Unknown external usage tool/);
});

test('external usage windows are idempotent and partial overlaps fail closed', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-external-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ExternalUsageStore({ dataDirectory: root });
  await store.initialize();
  const first = await store.record('usr_a', snapshot());
  assert.equal(first.accepted, true);
  const duplicate = await store.record('usr_a', snapshot());
  assert.equal(duplicate.duplicate, true);
  await assert.rejects(
    () => store.record('usr_a', snapshot({
      tokens: {
        windowId: 'window-overlap',
        windowStart: '2026-07-15T08:30:00.000Z',
        windowEnd: '2026-07-15T10:00:00.000Z',
        byModel: { 'claude-test': { inputTokens: 1, outputTokens: 1 } },
      },
    })),
    (error) => error.status === 409 && error.details.code === 'overlapping-token-window',
  );
  const summary = await store.summary({ days: 90, users: [{ id: 'usr_a', name: 'Alice', role: 'admin' }] });
  assert.equal(summary.events, 1);
  assert.equal(summary.totals.totalTokens, 130);
  assert.equal(summary.byUser[0].name, 'Alice');
});

test('external usage summary can be limited to the current actor', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-external-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ExternalUsageStore({ dataDirectory: root });
  await store.initialize();
  await store.record('usr_a', snapshot({ machineId: 'machine-a' }));
  await store.record('usr_b', snapshot({
    machineId: 'machine-b',
    tokens: {
      windowId: 'window-b',
      windowStart: '2026-07-15T08:00:00.000Z',
      windowEnd: '2026-07-15T09:00:00.000Z',
      byModel: { 'codex-test': { inputTokens: 4, outputTokens: 6, totalTokens: 10 } },
    },
    quota: {
      source: 'codex-app-server',
      windows: [{ limitId: 'codex', windowId: 'weekly', usedPercent: 8, resetsAt: '2026-07-16T03:00:00.000Z' }],
    },
  }));

  const summary = await store.summary({
    days: 90,
    users: [{ id: 'usr_b', name: 'Bob', role: 'member' }],
    actorUserIds: ['usr_b'],
  });

  assert.equal(summary.events, 1);
  assert.equal(summary.totals.totalTokens, 10);
  assert.deepEqual(summary.byUser.map((item) => item.userId), ['usr_b']);
  assert.equal(summary.quota.length, 1);
  assert.equal(summary.quota[0].actorUserId, 'usr_b');
  assert.equal(summary.quota[0].actorName, 'Bob');
});

test('quota freshness handles live, stale, inferred reset, and missing reset', () => {
  const now = new Date('2026-07-15T10:00:00.000Z');
  const base = { usedPercent: 35, resetsAt: '2026-07-15T11:00:00.000Z' };
  assert.equal(quotaFreshness(base, '2026-07-15T09:45:00.000Z', now).freshness, 'LIVE');
  assert.equal(quotaFreshness(base, '2026-07-15T09:44:59.000Z', now).freshness, 'STALE');
  const inferred = quotaFreshness({ ...base, resetsAt: '2026-07-15T09:00:00.000Z' }, '2026-07-15T09:00:00.000Z', now);
  assert.equal(inferred.freshness, 'RESET_INFERRED');
  assert.equal(inferred.inferredUsedPercent, 0);
  assert.equal(inferred.lastKnownUsedPercent, 35);
  const freshlyCollectedExpired = quotaFreshness({ ...base, resetsAt: '2026-07-15T09:59:00.000Z' }, '2026-07-15T09:59:30.000Z', now);
  assert.equal(freshlyCollectedExpired.freshness, 'RESET_INFERRED');
  assert.equal(freshlyCollectedExpired.effectiveUsedPercent, 0);
  assert.equal(quotaFreshness({ usedPercent: 35, resetsAt: null }, '2026-07-15T09:00:00.000Z', now).freshness, 'STALE');
});
