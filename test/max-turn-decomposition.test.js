import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMaxTurnRecoveryPlan,
  isExhaustedMaxTurnFailure,
  isRecoverablePartialMaxTurnFailure,
  terminalMaxTurnDecision,
} from '../src/max-turn-decomposition.js';

const task = {
  id: 'tsk_parent',
  title: 'Large contract task',
  acceptanceCriteria: ['first contract', 'second contract', 'third contract'],
  allowedPaths: ['src/**', 'test/**'],
  verificationProfile: 'node-project',
  executorProfileId: 'worker',
  reviewerProfileId: 'reviewer',
  automationGuard: { tokenBudget: 300_000, costBudgetUsd: 9 },
  verification: { passed: false, changedPaths: [], checks: [{ executorFailure: { subtype: 'error_max_turns' } }] },
};

test('exhausted max-turn work becomes sequential bounded recovery tasks', () => {
  assert.equal(isExhaustedMaxTurnFailure(task), true);
  const plan = buildMaxTurnRecoveryPlan(task);
  assert.equal(plan.steps.length, 3);
  assert.deepEqual(plan.steps.map((step) => step.acceptanceCriteria), [['first contract'], ['second contract'], ['third contract']]);
  assert.deepEqual(plan.steps.map((step) => step.dependsOn), [[], ['recovery-1'], ['recovery-2']]);
  assert.ok(plan.steps.every((step) => step.approvalPolicy === 'AUTO'));
  assert.ok(plan.steps.every((step) => step.delegation.budget.tokenBudget === 100_000));
});

test('partial work and nested depth two do not decompose again', () => {
  assert.equal(isExhaustedMaxTurnFailure({ ...task, verification: { ...task.verification, changedPaths: ['src/a.js'] } }), false);
  assert.equal(buildMaxTurnRecoveryPlan({ ...task, recovery: { depth: 2 } }), null);
});

test('partial max-turn work resumes only while its guard still permits recovery', () => {
  const task = {
    verification: {
      passed: false,
      changedPaths: ['src/example.js'],
      checks: [{ executorFailure: { subtype: 'error_max_turns' } }],
    },
    automationGuard: { circuitOpen: false, budgetExceeded: false },
  };
  assert.equal(isRecoverablePartialMaxTurnFailure(task), true);
  assert.equal(isRecoverablePartialMaxTurnFailure({
    ...task,
    automationGuard: { circuitOpen: true, budgetExceeded: false },
  }), false);
});

test('maximum recovery depth escalates once and then blocks critically', () => {
  const task = {
    delegation: { depth: 2 },
    automationGuard: { totalRuns: 1, circuitOpen: false, budgetExceeded: false },
  };
  assert.deepEqual(terminalMaxTurnDecision(task), { action: 'ESCALATE_ONCE', maxTurns: 24 });
  assert.deepEqual(terminalMaxTurnDecision({
    ...task,
    automationGuard: { ...task.automationGuard, totalRuns: 2 },
  }), { action: 'BLOCK_CRITICAL', maxTurns: 0 });
});
