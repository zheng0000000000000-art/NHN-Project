import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAgentDeliveryGate } from '../src/delivery-gate.js';

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
