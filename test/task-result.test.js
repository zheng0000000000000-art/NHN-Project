import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskResultMarkdown, taskResultFilename, taskResultSummary } from '../public/task-result.js';

const task = {
  id: 'tsk_001', title: '[B02] UTF-8 빌드', status: 'REVIEW',
  description: '단일 실행 파일을 만든다.',
  assigneeUserId: 'agent', reviewerUserId: 'human',
  acceptanceCriteria: ['빌드가 성공한다'],
  verification: {
    passed: true, status: 'PASSED', profile: 'node-project',
    changedPaths: ['build/build.py', 'package.json'], scopeViolations: [], failureCaseIds: [],
    executor: { tool: 'claude-code', model: 'claude-fable-5' },
    checks: [{ file: 'node', args: ['--test'], passed: true, actualExit: 0, expectedExit: 0, stdout: 'secret output', stderr: '' }],
  },
};
const users = [{ id: 'agent', name: 'GD_JM' }, { id: 'human', name: '최재혁' }];

test('result summary exposes review evidence at a glance', () => {
  assert.equal(taskResultSummary(task), '검증 통과 · 변경 파일 2개 · 검사 1/1개 통과');
});

test('result document contains changes, checks and executor without raw logs', () => {
  const markdown = buildTaskResultMarkdown(task, users, new Date('2026-07-20T00:00:00Z'));
  assert.match(markdown, /build\/build\.py/);
  assert.match(markdown, /node --test/);
  assert.match(markdown, /claude-code \/ claude-fable-5/);
  assert.match(markdown, /최재혁/);
  assert.doesNotMatch(markdown, /secret output/);
});

test('result filename is safe and identifies the artifact', () => {
  assert.equal(taskResultFilename({ title: 'B/02: UTF-8 빌드' }), 'B-02-UTF-8-빌드-작업-결과.md');
});
