import test from 'node:test';
import assert from 'node:assert/strict';
import { recordAutomationResult } from '../src/automation-guard.js';

test('automation circuit opens after the same failure repeats twice', () => {
  const first = recordAutomationResult({}, { passed: false, failureSignature: 'scope:a' });
  assert.equal(first.guard.circuitOpen, false);
  const second = recordAutomationResult(first.guard, { passed: false, failureSignature: 'scope:a' });
  assert.equal(second.guard.circuitOpen, true);
  assert.match(second.reason, /같은 실패가 2회/);
});

test('automation circuit opens after three different consecutive failures', () => {
  const one = recordAutomationResult({}, { passed: false, failureSignature: 'a' });
  const two = recordAutomationResult(one.guard, { passed: false, failureSignature: 'b' });
  const three = recordAutomationResult(two.guard, { passed: false, failureSignature: 'c' });
  assert.equal(three.guard.circuitOpen, true);
  assert.match(three.reason, /3회 연속 실패/);
});

test('a passing run resets consecutive failure counters', () => {
  const result = recordAutomationResult({ totalRuns: 2, failedRuns: 2, sameFailureCount: 1 }, { passed: true });
  assert.equal(result.guard.totalRuns, 3);
  assert.equal(result.guard.failedRuns, 0);
  assert.equal(result.guard.circuitOpen, false);
});
