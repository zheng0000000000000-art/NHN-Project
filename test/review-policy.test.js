import test from 'node:test';
import assert from 'node:assert/strict';
import { canReviewTask } from '../public/review-policy.js';

const task = { status: 'REVIEW', assigneeUserId: 'choi', reviewerUserId: 'gd' };

test('administrator can review regardless of assignment', () => {
  assert.equal(canReviewTask(task, { id: 'choi', role: 'admin' }), true);
  assert.equal(canReviewTask(task, { id: 'third', role: 'admin' }), true);
});

test('ordinary assignee cannot self-review', () => {
  assert.equal(canReviewTask(task, { id: 'choi', role: 'member' }), false);
});

test('ordinary designated reviewer can review', () => {
  assert.equal(canReviewTask(task, { id: 'gd', role: 'member' }), true);
});
