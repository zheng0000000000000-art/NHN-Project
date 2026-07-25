import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDeliveryFailure } from '../src/delivery-failures.js';

test('delivery failures classify stale locks without storing volatile task identity', () => {
  const result = classifyDeliveryFailure(new Error("Unable to create 'C:/repo/.git/index.lock': File exists."));
  assert.equal(result.kind, 'STALE_GIT_LOCK');
  assert.equal(result.harnessId, 'delivery-integrity');
  assert.deepEqual(result.identity.paths, []);
});

test('delivery conflicts retain normalized paths for deduplication', () => {
  const result = classifyDeliveryFailure(new Error([
    'Your local changes to the following files would be overwritten by merge:',
    '\tsrc/a.js',
    '\ttest/a.test.js',
    'Please commit your changes or stash them before you merge.',
  ].join('\n')));
  assert.equal(result.kind, 'DELIVERY_CONFLICT');
  assert.deepEqual(result.identity.paths, ['src/a.js', 'test/a.test.js']);
});

test('missing worktrees and git executable failures are distinct', () => {
  assert.equal(classifyDeliveryFailure(new Error('Task delivery worktree is missing: C:/repo/wt')).kind, 'WORKTREE_MISSING');
  assert.equal(classifyDeliveryFailure(new Error('spawn git ENOENT')).kind, 'GIT_EXECUTION_ERROR');
});
