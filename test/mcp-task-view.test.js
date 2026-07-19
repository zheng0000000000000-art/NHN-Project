import test from 'node:test';
import assert from 'node:assert/strict';
import { taskListView } from '../src/mcp-task-view.js';

const task = {
  id: 'B03', title: 'Split engine modules', status: 'READY',
  description: 'A long task description that list views do not need.',
  allowedPaths: ['src/engine/**', 'test/engine/**'],
  assigneeUserId: 'usr_owner', executionState: 'QUEUED', version: 7,
  verification: { checks: [{ output: 'large command output' }] },
};

test('brief task view contains only identity and status', () => {
  assert.deepEqual(taskListView(task), { id: 'B03', title: 'Split engine modules', status: 'READY' });
});

test('work task view adds only fields needed to choose and claim work', () => {
  assert.deepEqual(taskListView(task, 'work'), {
    id: 'B03', title: 'Split engine modules', status: 'READY',
    allowedPaths: ['src/engine/**', 'test/engine/**'],
    assigneeUserId: 'usr_owner', executionState: 'QUEUED', version: 7,
  });
});

test('brief mode materially reduces a realistic board payload', () => {
  const tasks = Array.from({ length: 33 }, (_, index) => ({ ...task, id: `B${index + 1}` }));
  const fullBytes = Buffer.byteLength(JSON.stringify(tasks));
  const briefBytes = Buffer.byteLength(JSON.stringify(tasks.map((item) => taskListView(item))));
  assert.ok(briefBytes < fullBytes * 0.3, `expected <30%, received ${Math.round((briefBytes / fullBytes) * 100)}%`);
});
