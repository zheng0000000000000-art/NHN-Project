import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { FailureCaseStore } from '../src/failure-cases.js';
import { HarnessRegistry } from '../src/harness-registry.js';
import { SkillRegistry } from '../src/skill-registry.js';
import { FailureLearningService } from '../src/failure-learning.js';
import { Store } from '../src/store.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-learning-'));
  const data = path.join(root, 'data');
  const seed = path.join(root, 'profiles.json');
  await writeFile(seed, JSON.stringify({ schemaVersion: 1, profiles: {
    builtin: { label: 'Built in', commands: [{ file: process.execPath, args: ['-e', 'process.exit(0)'] }] },
  } }));
  t.after(() => rm(root, { recursive: true, force: true }));

  const failureCases = new FailureCaseStore(data);
  const harnessRegistry = new HarnessRegistry({ dataDirectory: data, seedProfilePath: seed, workspaceRoot: root });
  const skillRegistry = new SkillRegistry({ dataDirectory: data });
  const store = new Store(data);
  await Promise.all([failureCases.initialize(), harnessRegistry.initialize(), skillRegistry.initialize(), store.initialize()]);
  const actor = await store.registerUser({ name: 'Alice', password: 'password-123' });
  const learning = new FailureLearningService({ failureCases, harnessRegistry, skillRegistry });
  return { root, failureCases, harnessRegistry, skillRegistry, store, actor, learning };
}

async function recordCommandFailure(failureCases, actor, { file, args, kind = 'EXIT_MISMATCH' }) {
  const timedOut = kind === 'TIMEOUT';
  const recorded = await failureCases.recordVerification({
    task: { id: 'tsk_source', title: 'Source task', verificationProfile: 'builtin' },
    verification: {
      profile: 'builtin', status: 'FAILED', passed: false, changedPaths: [], scopeViolations: [],
      checks: [{ file, args, cwd: '.', expectedExit: 0, actualExit: timedOut ? 2 : 1, timedOut, spawnError: false, passed: false, stdout: '', stderr: 'failed' }],
    },
    actorUserId: actor.id,
  });
  return recorded[0];
}

test('multiple failures can produce an active reusable skill', async (t) => {
  const { failureCases, skillRegistry, learning, actor } = await fixture(t);
  const commandFailure = await recordCommandFailure(failureCases, actor, { file: 'node', args: ['--test'] });
  const [scopeFailure] = await failureCases.recordVerification({
    task: { id: 'tsk_scope', verificationProfile: 'builtin' },
    verification: { profile: 'builtin', status: 'FAILED', passed: false, checks: [], changedPaths: ['Secrets/key.txt'], scopeViolations: ['Secrets/key.txt'] },
    actorUserId: actor.id,
  });

  const crafted = await learning.craft(actor, {
    type: 'SKILL', id: 'avoid-known-failures', label: 'Avoid known failures',
    failureCaseIds: [commandFailure.id, scopeFailure.id],
  });
  assert.equal(crafted.skill.status, 'DRAFT');
  assert.equal(crafted.skill.rules.length, 2);
  assert.match(crafted.skill.rules.join('\n'), /node --test/);
  assert.match(crafted.skill.rules.join('\n'), /Secrets\/key\.txt/);
  const active = await skillRegistry.setStatus(crafted.skill.id, actor.id, crafted.skill.version, 'ACTIVE');
  assert.equal(active.status, 'ACTIVE');
  assert.deepEqual(active.sourceFailureCaseIds.sort(), [commandFailure.id, scopeFailure.id].sort());
});

test('command failures can produce a regression harness and scope-only failures cannot', async (t) => {
  const { root, failureCases, harnessRegistry, learning, actor } = await fixture(t);
  const script = path.join(root, 'check.mjs');
  await writeFile(script, 'process.exit(1);\n');
  const commandFailure = await recordCommandFailure(failureCases, actor, { file: process.execPath, args: ['check.mjs'] });
  await writeFile(script, 'process.exit(0);\n');

  const crafted = await learning.craft(actor, {
    type: 'HARNESS', id: 'regression-check', label: 'Regression check', failureCaseIds: [commandFailure.id],
  });
  assert.equal(crafted.harness.source, 'FAILURE_DERIVED');
  assert.deepEqual(crafted.harness.sourceFailureCaseIds, [commandFailure.id]);
  assert.equal(crafted.harness.fixtureCandidates.length, 1);
  const tested = await harnessRegistry.test(crafted.harness.id, actor.id);
  assert.equal(tested.test.passed, true);
  const active = await harnessRegistry.setStatus(crafted.harness.id, actor.id, tested.harness.version, 'ACTIVE');
  assert.equal(active.status, 'ACTIVE');

  const [scopeFailure] = await failureCases.recordVerification({
    task: { id: 'tsk_scope', verificationProfile: 'builtin' },
    verification: { profile: 'builtin', status: 'FAILED', passed: false, checks: [], changedPaths: ['Outside.txt'], scopeViolations: ['Outside.txt'] },
    actorUserId: actor.id,
  });
  await assert.rejects(() => learning.craft(actor, {
    type: 'HARNESS', id: 'scope-only', label: 'Scope only', failureCaseIds: [scopeFailure.id],
  }), /do not contain executable command evidence/i);
});

test('only active harnesses and skills can be applied to a task', async (t) => {
  const { root, failureCases, harnessRegistry, skillRegistry, learning, store, actor } = await fixture(t);
  const script = path.join(root, 'check.mjs');
  await writeFile(script, 'process.exit(0);\n');
  const commandFailure = await recordCommandFailure(failureCases, actor, { file: process.execPath, args: ['check.mjs'] });
  const harnessResult = await learning.craft(actor, {
    type: 'HARNESS', id: 'learned-check', label: 'Learned check', failureCaseIds: [commandFailure.id],
  });
  const skillResult = await learning.craft(actor, {
    type: 'SKILL', id: 'learned-rule', label: 'Learned rule', failureCaseIds: [commandFailure.id],
  });
  const task = await store.createTask(actor, {
    title: 'Apply learning', allowedPaths: ['**'], verificationProfile: 'builtin', acceptanceCriteria: [],
  }, await harnessRegistry.activeIds());

  await assert.rejects(() => learning.applyToTask({
    actor, store, taskId: task.id, expectedVersion: task.version,
    harnessId: harnessResult.harness.id, skillIds: [skillResult.skill.id],
  }), /not active/i);

  const tested = await harnessRegistry.test(harnessResult.harness.id, actor.id);
  await harnessRegistry.setStatus(harnessResult.harness.id, actor.id, tested.harness.version, 'ACTIVE');
  await skillRegistry.setStatus(skillResult.skill.id, actor.id, skillResult.skill.version, 'ACTIVE');

  const applied = await learning.applyToTask({
    actor, store, taskId: task.id, expectedVersion: task.version,
    harnessId: harnessResult.harness.id, skillIds: [skillResult.skill.id],
  });
  assert.equal(applied.task.verificationProfile, harnessResult.harness.id);
  assert.deepEqual(applied.task.skillIds, [skillResult.skill.id]);
  assert.equal(applied.task.learning.applications.length, 1);
  assert.deepEqual(applied.task.learning.applications[0].sourceFailureCaseIds, [commandFailure.id]);
});
