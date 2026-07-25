import test from 'node:test';
import assert from 'node:assert/strict';
import { executionMode, executionState, publicExecutionLabel, publicWorkflowLabel, workflowPhase } from '../public/task-execution.js';

test('execution values fail back to simple human and idle states', () => {
  assert.equal(executionMode('agent'), 'AGENT');
  assert.equal(executionMode('unknown'), 'HUMAN');
  assert.equal(executionState('running'), 'RUNNING');
  assert.equal(executionState('recovering'), 'RECOVERING');
  assert.equal(executionState('finished'), 'IDLE');
});

test('board labels expose state without executor details', () => {
  assert.equal(publicExecutionLabel({ executionMode: 'AGENT', executionState: 'QUEUED', executor: { tool: 'codex', model: 'secret-model' } }), '에이전트 대기');
  assert.equal(publicExecutionLabel({ executionMode: 'AGENT', executionState: 'RUNNING', executor: { tool: 'claude-code' } }), '에이전트 실행 중');
  assert.equal(publicExecutionLabel({ executionMode: 'AGENT', executionState: 'RECOVERING' }), '자동 작업 복구 중');
  assert.equal(publicExecutionLabel({ executionMode: 'HUMAN', executionState: 'IDLE' }), '');
});

test('workflow labels keep execution and approval phases mutually exclusive', () => {
  const verified = { status: 'IN_PROGRESS', executionState: 'IDLE', verification: { passed: true } };
  assert.equal(workflowPhase(verified), 'READY_FOR_REVIEW');
  assert.equal(publicWorkflowLabel(verified), '리뷰 요청 필요');
  assert.equal(publicWorkflowLabel({ ...verified, status: 'REVIEW' }), '승인 대기');
  assert.equal(publicWorkflowLabel({ ...verified, status: 'DONE' }), '승인 완료');
  assert.equal(publicWorkflowLabel({ ...verified, executionState: 'RUNNING', verification: null }), '에이전트 실행 중');
});
