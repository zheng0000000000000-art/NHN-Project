import assert from 'node:assert/strict';
import { applyAgentDeliveryGate } from '../../src/delivery-gate.js';

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

export const scenarios = [
  {
    name: 'clean-success',
    verification: { status: 'PASSED', passed: true, checks: [], changedPaths: ['src/a.js'] },
    task: { executionMode: 'AGENT', allowNoChanges: false },
    executionResult: { exitCode: 0 },
    expect(result) {
      assert.equal(result.passed, true);
      assert.equal(result.status, 'PASSED');
    },
  },
  {
    name: 'executor-failure',
    verification: { status: 'PASSED', passed: true, checks: [], changedPaths: ['src/a.js'] },
    task: { executionMode: 'AGENT', allowNoChanges: false },
    executionResult: { exitCode: 1 },
    expect(result) {
      assert.equal(result.passed, false);
      assert.deepEqual(result.deliveryGate.failureKinds, ['EXECUTOR_FAILED']);
    },
  },
  {
    name: 'no-deliverable',
    verification: { status: 'PASSED', passed: true, checks: [], changedPaths: [] },
    task: { executionMode: 'AGENT', allowNoChanges: false },
    executionResult: { exitCode: 0 },
    expect(result) {
      assert.equal(result.passed, false);
      assert.deepEqual(result.deliveryGate.failureKinds, ['NO_DELIVERABLE']);
    },
  },
  {
    name: 'turn-limit-recovery',
    verification: { status: 'PASSED', passed: true, checks: [], changedPaths: ['src/a.js'] },
    task: { executionMode: 'AGENT', allowNoChanges: false },
    executionResult: {
      exitCode: 1,
      outputExcerpt: JSON.stringify({
        subtype: 'error_max_turns',
        is_error: true,
        result: 'Reached max turns before producing a patch.',
      }),
    },
    expect(result) {
      assert.equal(result.passed, false);
      assert.deepEqual(result.deliveryGate.failureKinds, ['EXECUTOR_FAILED']);
      assert.match(result.checks.at(-1).stdoutTail, /error_max_turns/);
    },
  },
  {
    name: 'human-verification-bypass',
    verification: { status: 'PASSED', passed: true, checks: [], changedPaths: [] },
    task: { executionMode: 'HUMAN', allowNoChanges: false },
    executionResult: {},
    expect(result) {
      assert.equal(result.passed, true);
    },
  },
];

export function runScenario(scenario) {
  const verificationInput = freezeDeep(structuredClone(scenario.verification));
  const taskInput = freezeDeep(structuredClone(scenario.task));
  const executionInput = freezeDeep(structuredClone(scenario.executionResult));
  const before = JSON.stringify([verificationInput, taskInput, executionInput]);

  const firstRun = applyAgentDeliveryGate(verificationInput, taskInput, executionInput);
  const secondRun = applyAgentDeliveryGate(verificationInput, taskInput, executionInput);

  const after = JSON.stringify([verificationInput, taskInput, executionInput]);
  assert.equal(before, after, `${scenario.name}: scenario inputs must not mutate across repeated execution`);
  assert.deepEqual(firstRun, secondRun, `${scenario.name}: repeated execution must produce an identical result`);
  scenario.expect(firstRun);
  return firstRun;
}
