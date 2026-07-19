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

test('command failure identity ignores actual exit but keeps cwd separate', async (t) => {
  const store = await storeFixture(t);
  const base = {
    task: { id: 'tsk_1', verificationProfile: 'node-tests' },
    verification: {
      profile: 'node-tests', status: 'FAILED', passed: false, changedPaths: [], scopeViolations: [],
      checks: [{ file: 'node', args: ['--test'], cwd: 'app', expectedExit: 0, actualExit: 1, timedOut: false, passed: false, stdout: '', stderr: 'failed' }],
    },
    actorUserId: 'usr_1',
  };
  const first = await store.recordVerification(base);
  const second = await store.recordVerification({
    ...base,
    task: { ...base.task, id: 'tsk_2' },
    verification: { ...base.verification, checks: [{ ...base.verification.checks[0], actualExit: 2 }] },
  });
  const third = await store.recordVerification({
    ...base,
    task: { ...base.task, id: 'tsk_3' },
    verification: { ...base.verification, checks: [{ ...base.verification.checks[0], cwd: 'tools', actualExit: 2 }] },
  });

  assert.equal(first[0].id, second[0].id);
  assert.notEqual(first[0].id, third[0].id);
  assert.equal((await store.get(first[0].id)).occurrences, 2);
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

test('multiple scope violations from one verification are recorded as one event', async (t) => {
  const store = await storeFixture(t);
  const recorded = await store.recordVerification({
    task: { id: 'tsk_scope_many', verificationProfile: 'repo' },
    verification: {
      profile: 'repo',
      status: 'FAILED',
      passed: false,
      checks: [],
      changedPaths: ['public/app.js', 'server.js', 'README.md'],
      scopeViolations: ['server.js', 'public/app.js'],
    },
    actorUserId: 'usr_1',
  });

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].kind, 'SCOPE_VIOLATION');
  assert.deepEqual(recorded[0].identity.paths, ['public/app.js', 'server.js']);
  assert.match(recorded[0].title, /2 paths/);
});

test('process failures are recorded and deduplicated without fake command output', async (t) => {
  const store = await storeFixture(t);
  const payload = {
    harnessId: 'workflow-integrity',
    kind: 'TASK_SUPERSESSION_MISSING',
    title: 'Replacement completed while original remained active',
    taskIds: ['tsk_old', 'tsk_new'],
    identity: { originalTaskId: 'tsk_old', replacementTaskId: 'tsk_new' },
    evidence: { originalStatus: 'READY', replacementStatus: 'DONE' },
  };
  const first = await store.recordProcessFailure(payload, 'usr_admin');
  const second = await store.recordProcessFailure(payload, 'usr_admin');
  assert.equal(first.id, second.id);
  assert.equal((await store.get(first.id)).occurrences, 2);
});

test('active linked artifacts resolve only failures they cover after the latest occurrence', async (t) => {
  const store = await storeFixture(t);
  const failure = await store.recordProcessFailure({ kind: 'DELIVERY_MISSING', title: 'Output not delivered' }, 'usr_1');
  await store.linkLearningArtifact(failure.id, 'usr_1', { type: 'SKILL', id: 'delivery-before-done', version: 1 });
  const resolved = await store.resolveCoveredByActiveArtifacts({ skillIds: ['delivery-before-done'] }, 'system');
  assert.deepEqual(resolved, [failure.id]);
  assert.equal((await store.get(failure.id)).status, 'RESOLVED');
});

test('a later passing task verification resolves its open failures', async (t) => {
  const store = await storeFixture(t);
  const [failure] = await store.recordVerification({
    task: { id: 'tsk_retry', verificationProfile: 'node-project' },
    verification: { profile: 'node-project', status: 'FAILED', passed: false, changedPaths: [], scopeViolations: [], checks: [
      { file: 'node', args: ['--test'], expectedExit: 0, actualExit: 1, passed: false },
    ] },
    actorUserId: 'usr_1',
  });
  const resolved = await store.resolveTaskFailuresOnPass('tsk_retry', 'node-project', 'usr_1');
  assert.deepEqual(resolved, [failure.id]);
  assert.equal((await store.get(failure.id)).status, 'RESOLVED');
});
