import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KNOWLEDGE_PROMOTION_CONTRACT,
  inferSkillManifest,
  normalizeContextPackContract,
  normalizeGateManifest,
  normalizeHarnessContract,
  normalizeLoopDefinition,
  normalizeLoopState,
  normalizeBalanceSpec,
  normalizeObservationSet,
  normalizeExperienceEvent,
  normalizeSkillManifest,
} from '../src/contracts.js';

test('context pack accepts the legacy Dashboard fields and emits the shared contract', () => {
  const sha256 = 'a'.repeat(64);
  const contract = normalizeContextPackContract({
    diId: 'DLINT-01',
    requiredInputs: [{ path: 'docs/header.md', sha256 }],
    readOrder: ['docs/runtime.md', 'docs/header.md'],
    allowlist: ['src/**'],
    forbiddenActions: ['git push'],
  });
  assert.equal(contract.packId, 'DLINT-01');
  assert.deepEqual(contract.writeScope, ['src/**']);
  assert.equal(contract.requiredInputs[0].sha256, sha256);
});

test('global loop, balance, observation, and experience contracts normalize legacy aliases', () => {
  const definition = normalizeLoopDefinition({
    projectId: 'balance-loop',
    steps: [{ id: 'simulate', completionCriteria: ['observations saved'] }],
  });
  assert.equal(definition.kind, 'team-loop-definition');
  assert.equal(definition.stages[0].stageId, 'simulate');

  const state = normalizeLoopState({ projectId: 'balance-loop', id: 'run-1', status: 'running', currentStage: 'simulate' });
  assert.equal(state.phase, 'running');
  assert.equal(state.stageId, 'simulate');

  const spec = normalizeBalanceSpec({
    id: 'combat-v1',
    variables: { enemyHealth: 100 },
    measurements: { clearTime: { target: 30, weight: 2 } },
    simulation: { horizon: 12, runsPerSeed: 100, seeds: [11, 23, 11], policies: ['value', 'risk'] },
  });
  assert.equal(spec.parameters.enemyHealth, 100);
  assert.equal(spec.metrics[0].metricId, 'clearTime');
  assert.equal(spec.search.deterministic, true);
  assert.deepEqual(spec.simulation, { horizon: 12, runsPerSeed: 100, seeds: [11, 23], policies: ['value', 'risk'] });

  const observations = normalizeObservationSet({
    measurementId: 'measure-1',
    specId: 'combat-v1',
    rows: [{ parameters: { enemyHealth: 100 }, metrics: { clearTime: 31.2 } }],
  });
  assert.equal(observations.observations[0].outputs.clearTime, 31.2);

  const event = normalizeExperienceEvent({
    id: 'event-1',
    type: 'failure',
    agentId: 'agent-a',
    lesson: 'Measure the target directly.',
  });
  assert.equal(event.actor, 'agent-a');
  assert.equal(event.summary, 'Measure the target directly.');
});

test('context pack rejects stale-prone or self-modifying declarations', () => {
  assert.throws(() => normalizeContextPackContract({
    packId: 'bad',
    requiredInputs: [{ path: 'src/a.js', sha256: 'a'.repeat(64) }],
    readOrder: ['src/a.js'],
    writeScope: ['src/**'],
  }), /Invalid context pack contract/);
});

test('skill manifest preserves the Dashboard five-field contract', () => {
  const manifest = normalizeSkillManifest({
    skillType: 'assisted',
    automationLevel: 6,
    humanApprovalPoints: ['Review promotion'],
    sideEffectScope: ['docs/wiki/**'],
    requiredCapabilities: ['Read failure evidence'],
  });
  assert.equal(Object.keys(manifest).length, 6);
  assert.equal(manifest.skillType, 'assisted');
  assert.equal(inferSkillManifest({ source: 'FAILURE_DERIVED' }).automationLevel, 6);
});

test('harness and gate adapters retain order, expected exits, and mutation truth', () => {
  const harness = normalizeHarnessContract({
    id: 'context-pack-integrity',
    commands: [{ file: 'node', args: ['check.js'], expectedExit: 1, mutatesState: false }],
  });
  assert.deepEqual(harness.checks[0], {
    order: 1, command: 'node', args: ['check.js'], expectedExit: 1,
    mutatesState: false, cwd: '.', timeoutMs: 120000,
  });
  const manifest = normalizeGateManifest({
    gates: [{ gateId: 'POST-EXECUTOR', checks: [{ command: 'context-pack-integrity', expectedExit: 0 }] }],
  });
  assert.equal(manifest.gates[0].checks[0].harnessId, 'context-pack-integrity');
  assert.equal(KNOWLEDGE_PROMOTION_CONTRACT.minimumOccurrences, 2);
  assert.equal(KNOWLEDGE_PROMOTION_CONTRACT.automaticPromotion, false);
});
