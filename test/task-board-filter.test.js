import test from 'node:test';
import assert from 'node:assert/strict';
import { filterTasksByPeople } from '../public/task-board-filter.js';

const tasks = [
  { id: 'a', assigneeUserId: 'choi', reviewerUserId: 'gd' },
  { id: 'b', assigneeUserId: 'gd', reviewerUserId: 'choi' },
  { id: 'c', assigneeUserId: 'choi', reviewerUserId: 'choi' },
];

test('filters tasks by assignee and reviewer independently', () => {
  assert.deepEqual(filterTasksByPeople(tasks, { assigneeUserId: 'choi' }).map((task) => task.id), ['a', 'c']);
  assert.deepEqual(filterTasksByPeople(tasks, { reviewerUserId: 'choi' }).map((task) => task.id), ['b', 'c']);
});

test('combines assignee and reviewer filters', () => {
  assert.deepEqual(filterTasksByPeople(tasks, { assigneeUserId: 'choi', reviewerUserId: 'gd' }).map((task) => task.id), ['a']);
});
