import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { FailureCaseStore } from '../../src/failure-cases.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-failure-dedupe-'));
try {
  const store = new FailureCaseStore(root);
  await store.initialize();

  const first = await store.recordVerification({
    task: { id: 'tsk_scope_many', verificationProfile: 'repository-basic' },
    verification: {
      profile: 'repository-basic',
      status: 'FAILED',
      passed: false,
      checks: [],
      changedPaths: ['server.js', 'public/app.js', 'public/styles.css'],
      scopeViolations: ['server.js', 'public/app.js', 'public/styles.css'],
    },
    actorUserId: 'usr_checker',
  });
  assert.equal(first.length, 1, 'scope violations from one verification must be one failure event');
  assert.deepEqual(first[0].identity.paths, ['public/app.js', 'public/styles.css', 'server.js']);

  const second = await store.recordVerification({
    task: { id: 'tsk_exit_1', verificationProfile: 'repository-basic' },
    verification: {
      profile: 'repository-basic',
      status: 'FAILED',
      passed: false,
      changedPaths: [],
      scopeViolations: [],
      checks: [{
        file: 'node',
        args: ['--test'],
        cwd: '.',
        expectedExit: 0,
        actualExit: 1,
        timedOut: false,
        spawnError: false,
        passed: false,
      }],
    },
    actorUserId: 'usr_checker',
  });
  const third = await store.recordVerification({
    task: { id: 'tsk_exit_2', verificationProfile: 'repository-basic' },
    verification: {
      profile: 'repository-basic',
      status: 'FAILED',
      passed: false,
      changedPaths: [],
      scopeViolations: [],
      checks: [{
        file: 'node',
        args: ['--test'],
        cwd: '.',
        expectedExit: 0,
        actualExit: 2,
        timedOut: false,
        spawnError: false,
        passed: false,
      }],
    },
    actorUserId: 'usr_checker',
  });
  assert.equal(second[0].id, third[0].id, 'actual exit changes must increment occurrences, not create duplicate cases');

  console.log('failure dedupe harness passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
