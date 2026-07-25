import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveAutomationTokens, recordAutomationResult } from '../src/automation-guard.js';

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

test('automation circuit pauses after a single expensive run even when it passes', () => {
  const result = recordAutomationResult({}, {
    passed: true,
    usage: { totalTokens: 600_000, costUsd: 2 },
    budget: { tokenBudget: 500_000, costBudgetUsd: 10 },
  });
  assert.equal(result.guard.circuitOpen, true);
  assert.equal(result.guard.budgetExceeded, true);
  assert.equal(result.guard.cumulativeTokens, 600_000);
  assert.match(result.reason, /token budget 500000 reached/);
});

test('automation cost accumulates across attempts', () => {
  const first = recordAutomationResult({}, {
    passed: false,
    failureSignature: 'a',
    usage: { totalTokens: 10, costUsd: 3.5 },
    budget: { costBudgetUsd: 5 },
  });
  const second = recordAutomationResult(first.guard, {
    passed: true,
    usage: { totalTokens: 10, costUsd: 1.5 },
    budget: { costBudgetUsd: 5 },
  });
  assert.equal(second.guard.circuitOpen, true);
  assert.equal(second.guard.cumulativeCostUsd, 5);
  assert.match(second.reason, /cost budget/);
});

test('automation token budget discounts cached input while preserving output', () => {
  assert.equal(effectiveAutomationTokens({
    inputTokens: 2_158_558,
    inputCachedTokens: 2_158_478,
    outputTokens: 17_688,
  }), 233_616);
});
