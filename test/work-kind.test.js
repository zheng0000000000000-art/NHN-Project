import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMaxTurnRecoveryPlan } from '../src/max-turn-decomposition.js';
import { classifyWorkKind, readOnlyReferences, referencedPaths } from '../src/work-kind.js';

// 이 세션에서 실제로 실행된 부모 태스크. 40턴에 한 번에 끝났다.
const PARENT = {
  id: 'tsk_afbd4dbb3fc57c4cb582',
  title: 'Cover the audit and handoff legs',
  allowedPaths: ['test/loop-failure-evidence.test.js'],
  verificationProfile: 'node-project',
  acceptanceCriteria: [
    'test/loop-failure-evidence.test.js exists and is the only changed file.',
    'It drives one intentional AGENT failure and asserts the audit record and the handoff text.',
  ],
  description: [
    'Copy the setup pattern from the existing passing test at test/server-security.test.js:401.',
    'Both helpers live there and are not exported, so copy them.',
    'Do not edit tools/verification/loop-scenarios.mjs.',
  ].join('\n'),
};

test('paths are read out of the task text, with or without a line suffix', () => {
  const found = referencedPaths('see test/server-security.test.js:401 and src/store.js');
  assert.deepEqual(found, ['src/store.js', 'test/server-security.test.js']);
  assert.deepEqual(referencedPaths(''), []);
  assert.deepEqual(referencedPaths(null), []);
});

test('a reference the task may also write is not a reading burden', () => {
  const reads = readOnlyReferences(PARENT);
  assert.ok(!reads.includes('test/loop-failure-evidence.test.js'), 'the file it writes is not something it must go read');
  assert.deepEqual(reads, ['src/store.js', 'test/server-security.test.js', 'tools/verification/loop-scenarios.mjs'].filter((p) => reads.includes(p)));
  assert.ok(reads.length >= 2);
});

test('a glob write scope still excludes what it covers', () => {
  const task = {
    allowedPaths: ['test/**'],
    acceptanceCriteria: ['touch test/a.test.js'],
    description: 'read src/store.js first',
  };
  assert.deepEqual(readOnlyReferences(task), ['src/store.js']);
});

test('work that only has to produce a file is separated from work that must read first', () => {
  const produce = classifyWorkKind({
    allowedPaths: ['test/loop-failure-evidence.test.js'],
    acceptanceCriteria: ['test/loop-failure-evidence.test.js exists and is the only changed file.'],
    description: 'Bounded recovery unit. Implement only this criterion.',
  });
  assert.equal(produce.kind, 'PRODUCE_ONLY');
  assert.equal(produce.evidence.readOnlyReferenceCount, 0);

  const parent = classifyWorkKind(PARENT);
  assert.equal(parent.kind, 'READ_THEN_PRODUCE');
  assert.ok(parent.evidence.readOnlyReferenceCount >= 2);
});

test('the classification carries its evidence, so a judgement can be checked', () => {
  const { evidence } = classifyWorkKind(PARENT);
  assert.ok(Array.isArray(evidence.readOnlyReferences));
  assert.equal(evidence.criteriaCount, 2);
  assert.equal(evidence.comprehensionWords, true);
});

test('a decomposed child keeps the reading burden its parent declared', () => {
  const plan = buildMaxTurnRecoveryPlan({ ...PARENT, automationGuard: {}, delegation: { depth: 0 } });
  assert.ok(plan, 'the parent must actually decompose');
  assert.equal(classifyWorkKind(PARENT).kind, 'READ_THEN_PRODUCE');

  for (const step of plan.steps) {
    const classified = classifyWorkKind(step);
    assert.equal(classified.kind, 'READ_THEN_PRODUCE',
      'a child whose parent had to read something must not look like trivial work');
    assert.ok(classified.evidence.readOnlyReferences.includes('test/server-security.test.js'),
      'the file the child must read has to survive decomposition');
  }
});

test('a child is still scoped to one criterion even though it inherits context', () => {
  const plan = buildMaxTurnRecoveryPlan({ ...PARENT, automationGuard: {}, delegation: { depth: 0 } });
  for (const [index, step] of plan.steps.entries()) {
    assert.deepEqual(step.acceptanceCriteria, [PARENT.acceptanceCriteria[index]],
      'inheriting context must not widen what the child is asked to satisfy');
    assert.match(step.description, /Implement only this criterion/);
  }
});

test('a parent with no description decomposes without inventing one', () => {
  const bare = { ...PARENT, description: '', automationGuard: {}, delegation: { depth: 0 } };
  const plan = buildMaxTurnRecoveryPlan(bare);
  for (const step of plan.steps) {
    assert.ok(!/Context inherited/.test(step.description), 'no context section when there was no context');
  }
});
