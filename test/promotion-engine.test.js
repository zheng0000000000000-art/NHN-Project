import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FailureCaseStore } from '../src/failure-cases.js';
import { SkillRegistry } from '../src/skill-registry.js';
import { PromotionEngine } from '../src/promotion-engine.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'promotion-engine-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const failureCases = new FailureCaseStore(directory);
  const skillRegistry = new SkillRegistry({ dataDirectory: directory });
  const harnessRegistry = {
    list: async () => [],
    get: async () => null,
    setStatus: async () => { throw new Error('Unexpected harness status change.'); },
  };
  await Promise.all([failureCases.initialize(), skillRegistry.initialize()]);
  const engine = new PromotionEngine({
    dataDirectory: directory,
    policyPath: path.resolve('config/promotion-policy.json'),
    failureCases,
    harnessRegistry,
    skillRegistry,
  });
  await engine.initialize();
  return { engine, failureCases, skillRegistry };
}

async function makeFailure(failureCases, actorId = 'owner') {
  return failureCases.recordProcessFailure({
    kind: 'SCOPE_VIOLATION',
    title: 'Changed outside allowed paths',
    identity: { path: 'outside.txt' },
    evidence: { paths: ['outside.txt'] },
  }, actorId);
}

test('optimistic skill promotion snapshots and activates a reversible candidate', async (t) => {
  const { engine, failureCases, skillRegistry } = await fixture(t);
  const actor = { id: 'owner', role: 'member' };
  const failure = await makeFailure(failureCases);
  const skill = await skillRegistry.createFromFailures(actor, {
    id: 'scope-guard-test',
    label: 'Scope guard test',
    rules: ['Check allowed paths before changing files.'],
  }, [failure]);
  const result = await engine.activate(actor, { type: 'SKILL', skill, sourceFailureCases: [failure] }, {
    rationale: 'Reversible local rule.',
    planner: 'test',
  });
  assert.equal(result.promotion.status, 'PROBATION');
  assert.equal(result.promotion.snapshot.status, 'DRAFT');
  assert.equal(result.skill.status, 'ACTIVE');
});

test('a recurring source failure automatically disables and rolls back probation learning', async (t) => {
  const { engine, failureCases, skillRegistry } = await fixture(t);
  const actor = { id: 'owner', role: 'member' };
  const failure = await makeFailure(failureCases);
  const skill = await skillRegistry.createFromFailures(actor, {
    id: 'rollback-scope-guard',
    label: 'Rollback scope guard',
    rules: ['Check allowed paths.'],
  }, [failure]);
  await engine.activate(actor, { type: 'SKILL', skill, sourceFailureCases: [failure] }, { rationale: 'Trial', planner: 'test' });
  await makeFailure(failureCases);
  const changes = await engine.audit(actor);
  assert.equal(changes[0].status, 'ROLLED_BACK');
  assert.equal((await skillRegistry.get(skill.id)).status, 'DISABLED');
  assert.equal((await engine.list(actor.id))[0].rollbackReason.includes('recurred'), true);
});

test('three clean audits stabilize optimistic learning', async (t) => {
  const { engine, failureCases, skillRegistry } = await fixture(t);
  const actor = { id: 'owner', role: 'member' };
  const failure = await makeFailure(failureCases);
  const skill = await skillRegistry.createFromFailures(actor, {
    id: 'stable-scope-guard',
    label: 'Stable scope guard',
    rules: ['Check allowed paths.'],
  }, [failure]);
  await engine.activate(actor, { type: 'SKILL', skill, sourceFailureCases: [failure] }, { rationale: 'Trial', planner: 'test' });
  await engine.audit(actor);
  await engine.audit(actor);
  const changes = await engine.audit(actor);
  assert.equal(changes[0].status, 'STABLE');
  assert.equal((await skillRegistry.get(skill.id)).status, 'ACTIVE');
});
