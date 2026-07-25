import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { TurnBudgetObservationStore, executorTelemetry, observationFromTask } from '../src/turn-budget-observations.js';

// 이 세션에서 실제로 관측된 두 실행을 그대로 재료로 쓴다.
function exhaustedTask(maxTurns, numTurns) {
  return {
    id: 'tsk_exhausted',
    verificationProfile: 'node-project',
    allowedPaths: ['test/loop-failure-evidence.test.js'],
    acceptanceCriteria: ['drives one intentional failure and asserts three things'],
    delegation: { depth: 1 },
    agentActivity: { preflight: { maxTurns, selectedContext: { estimatedTokens: 3000, sourceCount: 6 } } },
    automationGuard: { cumulativeTokens: 50298, cumulativeCostUsd: 0.392483 },
    verification: {
      passed: false,
      changedPaths: [],
      checks: [{
        file: 'agent-executor',
        executorFailure: {
          subtype: 'error_max_turns',
          outputExcerpt: JSON.stringify({
            num_turns: numTurns, terminal_reason: 'max_turns', permission_denials: [{ tool_name: 'Bash' }],
          }),
        },
      }],
    },
  };
}

const deliveredTask = {
  id: 'tsk_delivered',
  verificationProfile: 'node-project',
  allowedPaths: ['test/loop-failure-evidence.test.js'],
  acceptanceCriteria: ['a', 'b'],
  delegation: null,
  agentActivity: { preflight: { maxTurns: 40, selectedContext: { estimatedTokens: 3000, sourceCount: 6 } } },
  automationGuard: { cumulativeTokens: 50000, cumulativeCostUsd: 0.384737 },
  verification: { passed: true, changedPaths: ['test/loop-failure-evidence.test.js'], checks: [] },
};

test('executor telemetry is read from the run, and absent numbers stay null rather than zero', () => {
  const parsed = executorTelemetry(exhaustedTask(12, 13).verification);
  assert.equal(parsed.numTurns, 13);
  assert.equal(parsed.terminalReason, 'max_turns');
  assert.equal(parsed.permissionDenials, 1);

  const empty = executorTelemetry({ checks: [] });
  assert.equal(empty.numTurns, null, 'a missing turn count must not be recorded as zero turns');
  assert.equal(empty.terminalReason, null);
});

test('a run that burned its turns and produced nothing is distinguished from an ordinary failure', () => {
  const exhausted = observationFromTask(exhaustedTask(12, 13));
  assert.equal(exhausted.outcome, 'EXHAUSTED_TURNS_WITH_NOTHING');
  assert.equal(exhausted.delivered, false);
  assert.equal(exhausted.maxTurns, 12);
  assert.equal(exhausted.numTurns, 13);

  const plain = observationFromTask({
    id: 'x', verification: { passed: false, changedPaths: [], checks: [] }, agentActivity: { preflight: { maxTurns: 40 } },
  });
  assert.equal(plain.outcome, 'NO_DELIVERABLE', 'not every empty run is a turn-budget problem');
});

test('a delivering run records the budget it was given', () => {
  const observation = observationFromTask(deliveredTask);
  assert.equal(observation.outcome, 'DELIVERED_AND_PASSED');
  assert.equal(observation.maxTurns, 40);
  assert.equal(observation.changedPathCount, 1);
});

test('the shape is kept raw so the tier can be derived later, not baked in now', () => {
  const observation = observationFromTask(exhaustedTask(24, 25));
  assert.deepEqual(observation.allowedPaths, ['test/loop-failure-evidence.test.js']);
  assert.equal(observation.verificationProfile, 'node-project');
  assert.equal(observation.criteriaCount, 1);
  assert.equal(observation.delegationDepth, 1);
  assert.ok(!('tier' in observation), 'the tier must not be decided at record time');
});

test('observations append and summarise without proposing a value', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'turn-budget-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new TurnBudgetObservationStore(directory);

  assert.deepEqual(await store.list(), [], 'an unused store reads as empty, not as an error');

  await store.record(exhaustedTask(12, 13));
  await store.record(exhaustedTask(12, 13));
  await store.record(exhaustedTask(24, 25));
  await store.record(deliveredTask);

  const listed = await store.list();
  assert.equal(listed.length, 4, 'records append; nothing is rewritten');

  const summary = await store.summary();
  assert.equal(summary.observations, 4);
  assert.equal(summary.exhaustedWithNothing, 3);
  assert.equal(summary.delivered, 1);
  assert.equal(summary.maxTurnsSeenWhenExhausted, 24, 'the ceiling that still failed is the interesting number');
  assert.equal(summary.minTurnsSeenWhenDelivered, 40);
  assert.equal(summary.readyToChooseFloor, false, 'one delivering run is not enough evidence to set a floor');
  assert.ok(!('recommendedMaxTurns' in summary), 'the store must not invent the value a human should choose');
});
