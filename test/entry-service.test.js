import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { EntryService } from '../src/entry-service.js';

test('portfolio entry stays compact and project read plans load work context lazily', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'team-loop-entry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new EntryService({ dataDirectory: directory, workspaceRoot: directory });
  await service.initialize();
  const tasks = [makeTask({ status: 'IN_PROGRESS', version: 3 })];
  const portfolio = await service.portfolio(tasks);
  assert.equal(portfolio.kind, 'PORTFOLIO_ENTRY');
  assert.equal(portfolio.projects[0].activeWorkCount, 1);
  assert.equal('activeWorks' in portfolio.projects[0], false);
  const plan = await service.readPlan('team-loop', { intent: 'resume', workId: 'tsk_one', maxTokens: 4000 });
  assert.deepEqual(plan.required, ['project://team-loop/entry', 'work://tsk_one/contract', 'work://tsk_one/handoff/latest']);
  assert.equal(plan.budget.maxTokens, 4000);
  assert.ok(plan.excluded.includes('logs://raw/*'));
});

test('work ledger derives evidence and stores a factual end-of-command handoff', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'team-loop-handoff-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new EntryService({ dataDirectory: directory, workspaceRoot: directory });
  await service.initialize();
  const work = makeTask({
    status: 'IN_PROGRESS',
    version: 4,
    verification: { status: 'PASSED', passed: true, changedPaths: ['src/a.js'], finishedAt: '2026-07-25T00:00:00.000Z' },
  });
  const audits = [{ eventId: 'evt_1', at: '2026-07-25T00:00:00.000Z', actorUserId: 'usr_1', action: 'VERIFICATION_COMPLETED', data: { taskId: work.id } }];
  const handoff = await service.writeHandoff({ id: 'usr_1', role: 'admin' }, 'team-loop', work, audits, {
    trigger: 'AGENT_COMMAND_COMPLETED',
    decisions: ['Keep the entry layer thin.'],
  });
  assert.equal(handoff.status, 'READY_TO_RESUME');
  assert.equal(handoff.summaryStatus, 'FACTS_ONLY');
  assert.deepEqual(handoff.evidence.changedPaths, ['src/a.js']);
  assert.equal(handoff.nextAction.name, 'request_review');
  const ledger = await service.inspectWork('team-loop', work.id, work, audits);
  assert.equal(ledger.kind, 'WORK_LEDGER');
  assert.equal(ledger.timeline.length, 1);
  assert.equal(ledger.latestHandoff.id, handoff.id);
  assert.equal(ledger.checkpoints.length, 1);
});

test('registered projects appear without reading their project internals', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'team-loop-projects-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new EntryService({ dataDirectory: directory, workspaceRoot: directory });
  await service.initialize();
  await service.register({ id: 'usr_1', role: 'admin' }, {
    id: 'unknown-auction',
    title: 'Unknown Auction',
    purpose: 'Economy simulation',
    location: 'C:/Games/Unknown Auction',
  });
  const project = (await service.portfolio([])).projects.find((item) => item.id === 'unknown-auction');
  assert.equal(project.purpose, 'Economy simulation');
  assert.equal(project.activeWorkCount, 0);
  assert.equal(project.entryRef, 'project://unknown-auction/entry');
});

function makeTask(overrides = {}) {
  return {
    id: 'tsk_one',
    title: 'Build the entry protocol',
    description: 'Keep human and AI entry aligned.',
    status: 'READY',
    version: 1,
    updatedAt: '2026-07-25T00:00:00.000Z',
    archived: false,
    allowedPaths: ['src/**'],
    acceptanceCriteria: ['Agents can resume from a handoff.'],
    verificationProfile: 'repository-basic',
    skillIds: [],
    verification: null,
    review: null,
    executionMode: 'AGENT',
    executionState: 'IDLE',
    ...overrides,
  };
}
