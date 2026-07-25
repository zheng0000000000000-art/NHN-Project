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

test('disabled users keep their identity but cannot authenticate', async (t) => {
  const { directory, store } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = await store.registerUser({ name: 'Alice', password: 'password-1' });
  const oldMember = await store.registerUser({ name: 'Bob', password: 'password-2' });

  const disabled = await store.setUserDisabled(owner, oldMember.id, true);
  assert.equal(disabled.active, false);
  assert.ok(disabled.disabledAt);
  assert.equal((await store.listUsers()).find((user) => user.id === oldMember.id)?.name, 'Bob');
  await assert.rejects(
    () => store.authenticate('Bob', 'password-2'),
    (error) => error.status === 403,
  );
  await assert.rejects(
    () => store.setUserDisabled(owner, owner.id, true),
    (error) => error.status === 409,
  );
});

test('server startup recovers persisted RUNNING tasks as interrupted, not completed', async (t) => {
  const { directory, store } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = await store.registerUser({ name: 'Alice', password: 'password-1' });
  const created = await store.createTask(owner, {
    title: 'Interrupted agent work',
    allowedPaths: ['src/**'],
    verificationProfile: 'repository-basic',
  }, ['repository-basic']);
  const running = await store.mutateTask(created.id, owner, created.version, 'TEST_RUNNING', (next) => {
    next.status = 'IN_PROGRESS';
    next.executionMode = 'AGENT';
    next.executionState = 'RUNNING';
    next.agentActivity = { phase: 'executor-running', label: 'running' };
  });

  assert.deepEqual(await store.recoverInterruptedAgentTasks({ recoveryId: 'boot-1' }), [created.id]);
  const recovered = await store.getTask(created.id);
  assert.equal(recovered.status, 'IN_PROGRESS');
  assert.equal(recovered.executionState, 'RECOVERING');
  assert.equal(recovered.agentActivity.phase, 'recovering');
  assert.equal(recovered.agentActivity.passed, false);
  assert.equal(recovered.version, running.version + 1);
  assert.deepEqual(await store.recoverInterruptedAgentTasks({ recoveryId: 'boot-1' }), []);
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
  assert.equal(task.executionMode, 'HUMAN');
  assert.equal(task.executionState, 'IDLE');
  assert.equal(started.version, 2);
  await assert.rejects(
    () => store.mutateTask(task.id, alice, task.version, 'STALE', () => {}),
    (error) => error.status === 409,
  );
});

test('task creation can auto-apply the default harness and active skills', async (t) => {
  const { directory, store } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const alice = await store.registerUser({ name: 'Alice', password: 'password-1' });
  const task = await store.createTask(alice, {
    title: 'Auto applied task',
    allowedPaths: ['README.md'],
    acceptanceCriteria: [],
  }, ['repository-basic'], {
    defaultProfile: 'repository-basic',
    autoSkillIds: ['known-rule'],
  });
  assert.equal(task.verificationProfile, 'repository-basic');
  assert.deepEqual(task.skillIds, ['known-rule']);
  assert.equal(task.learning.applications.length, 1);
  assert.equal(task.learning.applications[0].automatic, true);
  assert.equal(task.learning.applications[0].harnessId, 'repository-basic');
  assert.deepEqual(task.learning.applications[0].skillIds, ['known-rule']);
});

test('explicit task harness and skills override automatic learning defaults', async (t) => {
  const { directory, store } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const alice = await store.registerUser({ name: 'Alice', password: 'password-1' });
  const task = await store.createTask(alice, {
    title: 'Explicit applied task',
    allowedPaths: ['README.md'],
    verificationProfile: 'custom',
    skillIds: ['explicit-rule'],
    acceptanceCriteria: [],
  }, ['repository-basic', 'custom'], {
    defaultProfile: 'repository-basic',
    autoSkillIds: ['known-rule'],
  });
  assert.equal(task.verificationProfile, 'custom');
  assert.deepEqual(task.skillIds, ['explicit-rule']);
  assert.equal(task.learning.applications[0].harnessId, null);
  assert.deepEqual(task.learning.applications[0].skillIds, ['explicit-rule']);
});

test('a PM plan atomically expands into linked dependency tasks', async (t) => {
  const { directory, store } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const alice = await store.registerUser({ name: 'Alice', password: 'password-1' });
  const plan = await store.createPlan(alice, {
    title: 'Information value loop',
    objective: 'Measure and tune information value.',
    allowedPaths: ['src/**', 'test/**'],
    steps: [
      { stepId: 'measure', title: 'Measure player decisions', acceptanceCriteria: ['Metrics are recorded'] },
      { stepId: 'tune', title: 'Tune information prices', dependsOn: ['measure'], acceptanceCriteria: ['A candidate is produced'] },
    ],
  }, ['repository-basic']);
  assert.equal(plan.tasks.length, 2);
  assert.equal(plan.tasks[0].planId, plan.planId);
  assert.deepEqual(plan.tasks[1].dependsOnTaskIds, [plan.tasks[0].id]);
  assert.equal((await store.listTasks()).length, 2);
});

test('a PM plan rejects dependency cycles without creating partial tasks', async (t) => {
  const { directory, store } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const alice = await store.registerUser({ name: 'Alice', password: 'password-1' });
  await assert.rejects(() => store.createPlan(alice, {
    title: 'Cyclic plan',
    objective: 'This must be rejected.',
    steps: [
      { stepId: 'a', title: 'Step alpha', dependsOn: ['b'], allowedPaths: ['**'] },
      { stepId: 'b', title: 'Step beta', dependsOn: ['a'], allowedPaths: ['**'] },
    ],
  }, ['repository-basic']), /cycle/i);
  assert.equal((await store.listTasks()).length, 0);
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
