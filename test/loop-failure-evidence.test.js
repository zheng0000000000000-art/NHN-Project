import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { applyAgentDeliveryGate } from '../src/delivery-gate.js';
import { classifyDeliveryFailure } from '../src/delivery-failures.js';
import { FailureCaseStore } from '../src/failure-cases.js';

async function storeFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-loop-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FailureCaseStore(root);
  await store.initialize();
  return store;
}

test('an intentional agent failure is asserted by the delivery gate with bounded executor evidence', () => {
  const passing = { status: 'PASSED', passed: true, checks: [], changedPaths: ['src/a.js'] };
  const outputExcerpt = JSON.stringify({
    subtype: 'error_max_turns',
    is_error: true,
    result: 'Intentional failure: agent stopped without delivering a patch.',
  });
  const gated = applyAgentDeliveryGate(passing, { executionMode: 'AGENT' }, { exitCode: 1, outputExcerpt });

  assert.equal(gated.passed, false);
  assert.deepEqual(gated.deliveryGate.failureKinds, ['EXECUTOR_FAILED']);
  const check = gated.checks.at(-1);
  assert.equal(check.executorFailure.subtype, 'error_max_turns');
  assert.equal(check.executorFailure.isError, true);
  assert.match(check.stdoutTail, /Intentional failure/);
});

test('an asserted agent failure is durably recorded as an audited failure case', async (t) => {
  const store = await storeFixture(t);
  const passing = { status: 'PASSED', passed: true, checks: [], changedPaths: [] };
  const outputExcerpt = JSON.stringify({
    subtype: 'error_max_turns',
    is_error: true,
    result: 'Intentional failure: agent stopped without delivering a patch.',
  });
  const gated = applyAgentDeliveryGate(passing, { executionMode: 'AGENT' }, { exitCode: 1, outputExcerpt });

  const task = { id: 'tsk_intentional_1', verificationProfile: 'agent-delivery' };
  const first = await store.recordVerification({ task, verification: gated, actorUserId: 'usr_audit' });
  const second = await store.recordVerification({
    task: { ...task, id: 'tsk_intentional_2' },
    verification: gated,
    actorUserId: 'usr_audit',
  });

  assert.equal(first.length, 2);
  const executorCase = first.find((item) => item.kind === 'EXECUTOR_FAILED');
  assert.ok(executorCase, 'executor failure must be recorded as an audit case');
  assert.equal(second.find((item) => item.kind === 'EXECUTOR_FAILED').id, executorCase.id);
  const stored = await store.get(executorCase.id);
  assert.equal(stored.occurrences, 2);
  assert.deepEqual(stored.taskIds.sort(), ['tsk_intentional_1', 'tsk_intentional_2']);
  assert.equal(stored.lastEvidence.executorFailure.subtype, 'error_max_turns');
});

test('handoff delivery failures classify as evidence and resolve once delivery succeeds', async (t) => {
  const store = await storeFixture(t);
  const error = new Error([
    'Your local changes to the following files would be overwritten by merge:',
    '\tsrc/handoff.js',
    'Please commit your changes or stash them before you merge.',
  ].join('\n'));

  const classified = classifyDeliveryFailure(error, { phase: 'handoff' });
  assert.equal(classified.kind, 'DELIVERY_CONFLICT');
  assert.equal(classified.harnessId, 'delivery-integrity');
  assert.deepEqual(classified.identity.paths, ['src/handoff.js']);

  const recorded = await store.recordProcessFailure({
    harnessId: classified.harnessId,
    kind: classified.kind,
    title: classified.title,
    taskIds: ['tsk_handoff'],
    identity: classified.identity,
    evidence: classified.evidence,
  }, 'usr_handoff');

  assert.equal(recorded.kind, 'DELIVERY_CONFLICT');
  assert.deepEqual(recorded.lastEvidence.paths, ['src/handoff.js']);

  const resolved = await store.resolveTaskProcessFailures(
    'tsk_handoff',
    'delivery-integrity',
    'usr_handoff',
    'Handoff delivered successfully after retry.',
  );

  assert.deepEqual(resolved, [recorded.id]);
  const final = await store.get(recorded.id);
  assert.equal(final.status, 'RESOLVED');
  assert.equal(final.statusNote, 'Handoff delivered successfully after retry.');
});
