import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'team-loop-store-'));
  const store = new Store(directory);
  await store.initialize();
  return { directory, store };
}

test('first user is admin and later users are members', async (t) => {
  const { directory, store } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await store.registerUser({ name: 'Alice', password: 'password-1' });
  const second = await store.registerUser({ name: 'Bob', password: 'password-2' });
  assert.equal(first.role, 'admin');
  assert.equal(second.role, 'member');
});

test('task mutations reject stale versions', async (t) => {
  const { directory, store } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const alice = await store.registerUser({ name: 'Alice', password: 'password-1' });
  const task = await store.createTask(alice, {
    title: 'Create movement controller',
    allowedPaths: ['Game/Player/**'],
    verificationProfile: 'repository-basic',
    acceptanceCriteria: ['Movement responds to input', 'Movement is tested'],
  }, ['repository-basic']);
  const started = await store.mutateTask(task.id, alice, task.version, 'TASK_STARTED', (next) => {
    next.status = 'IN_PROGRESS';
    next.assigneeUserId = alice.id;
  });
  assert.equal(task.acceptanceCriteria.length, 2);
  assert.equal(started.version, 2);
  await assert.rejects(
    () => store.mutateTask(task.id, alice, task.version, 'STALE', () => {}),
    (error) => error.status === 409,
  );
});

test('first administrator bootstrap expires without SIGNUP_CODE', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'team-loop-store-bootstrap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(directory, {
    serverStartedAt: Date.now() - 11 * 60 * 1000,
    bootstrapWindowMs: 10 * 60 * 1000,
  });
  await store.initialize();
  await assert.rejects(
    () => store.registerUser({ name: 'Alice', password: 'password-1' }),
    (error) => error.status === 403 && /SIGNUP_CODE/.test(error.message),
  );
});

test('configured SIGNUP_CODE is checked inside the registration lock', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'team-loop-store-code-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(directory, { signupCode: 'team-secret' });
  await store.initialize();
  await assert.rejects(
    () => store.registerUser({ name: 'Alice', password: 'password-1', signupCode: 'wrong' }),
    (error) => error.status === 403,
  );
  const user = await store.registerUser({ name: 'Alice', password: 'password-1', signupCode: 'team-secret' });
  assert.equal(user.role, 'admin');
});
