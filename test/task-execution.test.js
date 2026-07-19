import test from 'node:test';
import assert from 'node:assert/strict';
import { executionMode, executionState, publicExecutionLabel } from '../public/task-execution.js';

test('execution values fail back to simple human and idle states', () => {
  assert.equal(executionMode('agent'), 'AGENT');
  assert.equal(executionMode('unknown'), 'HUMAN');
  assert.equal(executionState('running'), 'RUNNING');
  assert.equal(executionState('finished'), 'IDLE');
});

test('board labels expose state without executor details', () => {
  assert.equal(publicExecutionLabel({ executionMode: 'AGENT', executionState: 'QUEUED', executor: { tool: 'codex', model: 'secret-model' } }), '에이전트 대기');
  assert.equal(publicExecutionLabel({ executionMode: 'AGENT', executionState: 'RUNNING', executor: { tool: 'claude-code' } }), '에이전트 실행 중');
  assert.equal(publicExecutionLabel({ executionMode: 'HUMAN', executionState: 'IDLE' }), '');
});
