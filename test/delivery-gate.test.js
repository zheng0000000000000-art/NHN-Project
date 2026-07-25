import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAgentDeliveryGate, normalizeExecutorFailure } from '../src/delivery-gate.js';

const passing = { status: 'PASSED', passed: true, checks: [], changedPaths: ['src/a.js'] };

test('agent delivery requires a successful executor exit', () => {
  const result = applyAgentDeliveryGate(passing, { executionMode: 'AGENT' }, { exitCode: 1 });
  assert.equal(result.passed, false);
  assert.deepEqual(result.deliveryGate.failureKinds, ['EXECUTOR_FAILED']);
});

test('agent delivery rejects a passing baseline with no changed deliverable', () => {
  const result = applyAgentDeliveryGate(
    { ...passing, changedPaths: [] },
    { executionMode: 'AGENT', allowNoChanges: false },
    { exitCode: 0 },
  );
  assert.equal(result.passed, false);
  assert.deepEqual(result.deliveryGate.failureKinds, ['NO_DELIVERABLE']);
});

test('explicit evidence-only tasks may allow no file changes', () => {
  const result = applyAgentDeliveryGate(
    { ...passing, changedPaths: [] },
    { executionMode: 'AGENT', allowNoChanges: true },
    { exitCode: 0 },
  );
  assert.equal(result.passed, true);
});

test('human verification does not require an agent delivery', () => {
  const result = applyAgentDeliveryGate(
    { ...passing, changedPaths: [] },
    { executionMode: 'HUMAN', allowNoChanges: false },
    {},
  );
  assert.equal(result.passed, true);
});

test('executor failure preserves a bounded structured reason for the failure corpus', () => {
  const outputExcerpt = JSON.stringify({
    subtype: 'error_max_turns',
    is_error: true,
    result: 'Reached max turns before producing a patch.',
  });
  const normalized = normalizeExecutorFailure({ outputExcerpt, durationMs: 1234 });
  assert.equal(normalized.subtype, 'error_max_turns');
  assert.equal(normalized.isError, true);
  assert.equal(normalized.reason, 'Reached max turns before producing a patch.');
  assert.equal(normalized.durationMs, 1234);
  const result = applyAgentDeliveryGate(passing, { executionMode: 'AGENT' }, { exitCode: 1, outputExcerpt });
  assert.match(result.checks.at(-1).stdoutTail, /error_max_turns/);
});

test('executor output evidence is capped to its final 4000 characters', () => {
  const normalized = normalizeExecutorFailure({ outputExcerpt: `prefix-${'x'.repeat(5000)}` });
  assert.equal(normalized.outputExcerpt.length, 4000);
  assert.equal(normalized.outputExcerpt, 'x'.repeat(4000));
});
