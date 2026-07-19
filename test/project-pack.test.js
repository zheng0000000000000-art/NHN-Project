import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectPack, materializeProjectPack, mergeProjectPackTasks } from '../src/project-pack.js';

const users = [{ id: 'u1', name: '최재혁', role: 'admin' }, { id: 'u2', name: 'GD_JM', role: 'member' }];
const task = {
  id: 'task-a', title: '시스템 규칙', description: '규칙 구현', priority: 10, status: 'IN_PROGRESS',
  assigneeUserId: 'u1', reviewerUserId: 'u2', allowedPaths: ['src/**'], acceptanceCriteria: ['테스트 통과'],
  verificationProfile: 'node-project', schedule: { plannedStart: '2026-07-20', plannedEnd: '2026-07-21', note: '' },
  skillIds: ['scope-guard'], verification: { passed: true }, archived: false,
};

test('project pack exports planning data without runtime verification or user ids', () => {
  const pack = createProjectPack({
    project: { id: 'unknown-auction', title: '미지의 경매장', repository: 'C:/game' }, tasks: [task], users,
    harnesses: [{ id: 'node-project', label: 'Node', commands: [] }], skills: [{ id: 'scope-guard', label: 'Scope', rules: [] }],
    exportedAt: '2026-07-19T00:00:00.000Z',
  });
  assert.equal(pack.tasks[0].assignee, '최재혁');
  assert.equal(pack.tasks[0].assigneeUserId, undefined);
  assert.equal(pack.tasks[0].verification, undefined);
  assert.equal(pack.harnesses.length, 1);
  assert.equal(pack.skills.length, 1);
});

test('project pack import resets runtime state and maps people by name', () => {
  const pack = createProjectPack({ project: { id: 'unknown-auction' }, tasks: [task], users });
  const [imported] = materializeProjectPack(pack, users, { now: '2026-07-19T01:00:00.000Z' });
  assert.equal(imported.status, 'READY');
  assert.equal(imported.assigneeUserId, 'u1');
  assert.equal(imported.reviewerUserId, 'u2');
  assert.equal(imported.verification, null);
  assert.equal(imported.projectPackId, 'unknown-auction');
});

test('project pack merge replaces its own tasks and preserves unrelated tasks', () => {
  const imported = [{ id: 'task-a', projectPackId: 'unknown-auction' }];
  const merged = mergeProjectPackTasks([{ id: 'old', projectPackId: 'unknown-auction' }, { id: 'other' }], imported, 'unknown-auction');
  assert.deepEqual(merged.map((item) => item.id), ['other', 'task-a']);
});
