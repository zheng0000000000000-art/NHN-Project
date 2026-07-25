// 실행·검증·AI리뷰·승인 상태가 서로 겹치지 않는다는 불변식을 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { publicExecutionLabel, publicWorkflowLabel, workflowPhase } from '../public/task-execution.js';

const STATUSES = ['READY', 'IN_PROGRESS', 'REVIEW', 'BLOCKED', 'DONE'];
const EXECUTION_STATES = ['IDLE', 'QUEUED', 'RUNNING', 'RECOVERING'];
const VERIFICATIONS = [null, { passed: false }, { passed: true }];

const EXECUTION_PHASES = new Set(['QUEUED', 'RUNNING', 'RECOVERING']);
const SETTLED_PHASES = new Set(['APPROVED', 'BLOCKED', 'AWAITING_APPROVAL']);
const KNOWN_PHASES = new Set([
  'APPROVED', 'BLOCKED', 'AWAITING_APPROVAL', 'RECOVERING', 'RUNNING',
  'QUEUED', 'READY_FOR_REVIEW', 'WORKING', 'READY',
]);

// 상태 조합 전체를 만든다.
function everyCombination() {
  const rows = [];
  for (const status of STATUSES) {
    for (const executionState of EXECUTION_STATES) {
      for (const verification of VERIFICATIONS) {
        rows.push({ status, executionState, verification, executionMode: 'AGENT' });
      }
    }
  }
  return rows;
}

test('every task shape resolves to exactly one known workflow phase with a label', () => {
  const rows = everyCombination();
  assert.equal(rows.length, STATUSES.length * EXECUTION_STATES.length * VERIFICATIONS.length);
  for (const task of rows) {
    const phase = workflowPhase(task);
    assert.ok(KNOWN_PHASES.has(phase), `unknown phase ${phase} for ${JSON.stringify(task)}`);
    assert.equal(typeof publicWorkflowLabel(task), 'string');
    assert.ok(publicWorkflowLabel(task).length > 0, `empty label for ${JSON.stringify(task)}`);
  }
});

test('a settled approval state is never reported as an execution phase', () => {
  for (const status of ['DONE', 'REVIEW', 'BLOCKED']) {
    for (const executionState of EXECUTION_STATES) {
      const phase = workflowPhase({ status, executionState, verification: { passed: true } });
      assert.ok(SETTLED_PHASES.has(phase), `${status}/${executionState} leaked into ${phase}`);
      assert.ok(!EXECUTION_PHASES.has(phase), `${status}/${executionState} must not be an execution phase`);
    }
  }
});

test('a still-running agent is never reported as ready for review', () => {
  for (const executionState of ['QUEUED', 'RUNNING', 'RECOVERING']) {
    const task = { status: 'IN_PROGRESS', executionState, verification: { passed: true } };
    const phase = workflowPhase(task);
    assert.notEqual(phase, 'READY_FOR_REVIEW', `${executionState} must not claim review readiness`);
    assert.ok(EXECUTION_PHASES.has(phase));
  }
});

test('review readiness requires a passed verification and an idle executor', () => {
  assert.equal(workflowPhase({ status: 'IN_PROGRESS', executionState: 'IDLE', verification: { passed: true } }), 'READY_FOR_REVIEW');
  assert.equal(workflowPhase({ status: 'IN_PROGRESS', executionState: 'IDLE', verification: { passed: false } }), 'WORKING');
  assert.equal(workflowPhase({ status: 'IN_PROGRESS', executionState: 'IDLE', verification: null }), 'WORKING');
});

test('execution and workflow labels never both claim an idle task', () => {
  for (const status of STATUSES) {
    for (const verification of VERIFICATIONS) {
      const task = { status, executionState: 'IDLE', verification, executionMode: 'AGENT' };
      assert.equal(publicExecutionLabel(task), '', `idle ${status} must not show an execution label`);
      assert.ok(publicWorkflowLabel(task).length > 0);
    }
  }
});

test('a human task never shows an agent execution label', () => {
  for (const executionState of EXECUTION_STATES) {
    assert.equal(publicExecutionLabel({ executionMode: 'HUMAN', executionState }), '');
  }
});
