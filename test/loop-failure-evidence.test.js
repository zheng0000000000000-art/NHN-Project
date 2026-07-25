import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { applyAgentDeliveryGate } from '../src/delivery-gate.js';
import { classifyDeliveryFailure } from '../src/delivery-failures.js';
import { FailureCaseStore } from '../src/failure-cases.js';
import { Store } from '../src/store.js';
import { EntryService } from '../src/entry-service.js';

async function storeFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-loop-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FailureCaseStore(root);
  await store.initialize();
  return store;
}

async function auditStoreFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-loop-failure-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.initialize();
  return store;
}

async function entryServiceFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-loop-failure-handoff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entryService = new EntryService({ dataDirectory: root, workspaceRoot: root });
  await entryService.initialize();
  return entryService;
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
  assert.deepEqual(classified.identity.paths, ['src/handoff.js']);

  const taskId = 'tsk_handoff_1';
  const recorded = await store.recordProcessFailure(
    {
      harnessId: classified.harnessId,
      kind: classified.kind,
      title: classified.title,
      taskIds: [taskId],
      identity: classified.identity,
      evidence: classified.evidence,
    },
    'usr_audit',
  );
  assert.equal(recorded.status, 'OPEN');

  const resolvedIds = await store.resolveTaskProcessFailures(taskId, classified.harnessId, 'usr_audit');
  assert.deepEqual(resolvedIds, [recorded.id]);
  const stored = await store.get(recorded.id);
  assert.equal(stored.status, 'RESOLVED');
});

test('an intentional agent failure produces an audit trail event and a resumable handoff record', async (t) => {
  const auditStore = await auditStoreFixture(t);
  const entryService = await entryServiceFixture(t);

  await auditStore.recordAudit('usr_audit', 'TASK_AGENT_INTERRUPTED', {
    taskId: 'tsk_intentional_3',
    reason: 'Intentional failure: agent stopped without delivering a patch.',
  });
  const events = await auditStore.listAuditEvents();
  const auditEvent = events.find((event) => event.data?.taskId === 'tsk_intentional_3');
  assert.ok(auditEvent, 'the intentional failure must be durably audited');
  assert.equal(auditEvent.action, 'TASK_AGENT_INTERRUPTED');

  const task = {
    id: 'tsk_intentional_3',
    title: 'Bounded objective that hit its turn limit',
    status: 'BLOCKED',
    version: 3,
    verification: { status: 'FAILED', passed: false, changedPaths: [] },
    review: null,
    blocked: { reason: 'Intentional failure: agent stopped without delivering a patch.' },
  };
  const handoff = await entryService.writeHandoff({ id: 'usr_audit' }, 'team-loop', task, [auditEvent], {
    trigger: 'AGENT_FAILURE',
    notes: 'Executor hit its turn limit before delivering a patch; recovery run required.',
  });

  assert.equal(handoff.status, 'BLOCKED');
  assert.equal(handoff.evidence.verificationPassed, false);
  assert.equal(handoff.evidence.latestAuditEventId, auditEvent.eventId);

  const latest = await entryService.latestHandoff('team-loop', task.id);
  assert.equal(latest.id, handoff.id);
});
