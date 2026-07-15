import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { FailureCaseStore } from '../src/failure-cases.js';

async function storeFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-failures-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FailureCaseStore(root);
  await store.initialize();
  return store;
}

test('failure cases deduplicate recurring command failures', async (t) => {
  const store = await storeFixture(t);
  const payload = {
    task: { id: 'tsk_1', verificationProfile: 'node-tests' },
    verification: {
      profile: 'node-tests', status: 'FAILED', passed: false, changedPaths: [], scopeViolations: [],
      checks: [{ file: 'node', args: ['--test'], expectedExit: 0, actualExit: 1, timedOut: false, passed: false, stdout: '', stderr: 'failed' }],
    },
    actorUserId: 'usr_1',
  };
  const first = await store.recordVerification(payload);
  const second = await store.recordVerification({ ...payload, task: { ...payload.task, id: 'tsk_2' } });
  assert.equal(first[0].id, second[0].id);
  const item = await store.get(first[0].id);
  assert.equal(item.occurrences, 2);
  assert.deepEqual(item.taskIds.sort(), ['tsk_1', 'tsk_2']);
});

test('scope violations are independent failure cases and can be resolved', async (t) => {
  const store = await storeFixture(t);
  const recorded = await store.recordVerification({
    task: { id: 'tsk_scope', verificationProfile: 'repo' },
    verification: { profile: 'repo', status: 'FAILED', passed: false, checks: [], changedPaths: ['Game/A.cs'], scopeViolations: ['Game/A.cs'] },
    actorUserId: 'usr_1',
  });
  assert.equal(recorded[0].kind, 'SCOPE_VIOLATION');
  const resolved = await store.setStatus(recorded[0].id, 'usr_2', 'RESOLVED', 'scope updated');
  assert.equal(resolved.status, 'RESOLVED');
  const repeated = await store.recordVerification({
    task: { id: 'tsk_scope2', verificationProfile: 'repo' },
    verification: { profile: 'repo', status: 'FAILED', passed: false, checks: [], changedPaths: ['Game/A.cs'], scopeViolations: ['Game/A.cs'] },
    actorUserId: 'usr_1',
  });
  assert.equal(repeated[0].status, 'OPEN');
});
