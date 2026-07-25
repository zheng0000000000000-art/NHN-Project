import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { FailureCaseStore } from '../src/failure-cases.js';
import { SkillRegistry } from '../src/skill-registry.js';
import { WikiStore } from '../src/wiki-store.js';
import { PromotionEngine } from '../src/promotion-engine.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'knowledge-filing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const failureCases = new FailureCaseStore(directory);
  const skillRegistry = new SkillRegistry({ dataDirectory: directory });
  const wikiStore = new WikiStore(directory);
  await Promise.all([failureCases.initialize(), skillRegistry.initialize(), wikiStore.initialize()]);
  const engine = new PromotionEngine({
    dataDirectory: directory,
    policyPath: path.resolve('config/promotion-policy.json'),
    failureCases,
    harnessRegistry: { list: async () => [], get: async () => null, setStatus: async () => { throw new Error('unexpected'); } },
    skillRegistry,
    wikiStore,
  });
  await engine.initialize();
  return { engine, wikiStore, failureCases };
}

const ACTOR = { id: 'owner', role: 'member' };
const UNDECIDABLE = {
  suggestedType: 'WIKI',
  title: 'Autonomous loop exhausted maximum recovery depth',
  occurrences: 2,
  evidenceBasis: 'REPORTED_OUTCOME',
  failureCaseIds: ['fail_undecidable'],
  score: { total: 6, verdict: 'HOLD', dimensions: { decidability: 0 } },
};
const CASES = [{ id: 'fail_undecidable', kind: 'PROCESS_FAILURE', title: 'Autonomous loop exhausted maximum recovery depth', occurrences: 2 }];

test('an undecidable candidate becomes a wiki candidate, not an active rule', async (t) => {
  const { engine, wikiStore } = await fixture(t);
  const filed = await engine.fileAsKnowledge(ACTOR, UNDECIDABLE, CASES);
  assert.equal(filed.duplicate, false);
  assert.equal(filed.entry.status, 'CANDIDATE', 'knowledge must wait for a human, not activate itself');
  const stored = await wikiStore.list({});
  assert.equal(stored.length, 1);
  assert.match(stored[0].title, /Autonomous loop exhausted/);
});

test('the entry records why it was not enforced as a rule', async (t) => {
  const { engine } = await fixture(t);
  const filed = await engine.fileAsKnowledge(ACTOR, UNDECIDABLE, CASES);
  assert.match(filed.entry.content, /REPORTED_OUTCOME/);
  assert.match(filed.entry.content, /PASS\/FAIL/);
  assert.match(filed.entry.content, /결정가능성 0/);
  assert.deepEqual(filed.entry.evidence, ['fail_undecidable'], 'the failure ids must stay attached as evidence');
  assert.ok(filed.entry.tags.includes('undecidable'));
});

test('filing leaves a receipt so the same candidate is not proposed forever', async (t) => {
  const { engine } = await fixture(t);
  const filed = await engine.fileAsKnowledge(ACTOR, UNDECIDABLE, CASES);
  assert.equal(filed.promotion.type, 'WIKI');
  assert.equal(filed.promotion.status, 'FILED');
  assert.deepEqual(filed.promotion.sourceFailureCaseIds, ['fail_undecidable']);
  const receipts = await engine.list(ACTOR.id);
  assert.equal(receipts.length, 1);

  const again = await engine.fileAsKnowledge(ACTOR, UNDECIDABLE, CASES);
  assert.equal(again.duplicate, true, 'the same knowledge must not be duplicated');
  assert.equal(again.promotion.status, 'ALREADY_FILED');
});

test('a decidable candidate is refused, because it belongs to a program', async (t) => {
  const { engine } = await fixture(t);
  await assert.rejects(
    () => engine.fileAsKnowledge(ACTOR, { ...UNDECIDABLE, suggestedType: 'HARNESS' }, CASES),
    /Only undecidable candidates/,
  );
});

test('without a wiki store the engine refuses rather than silently dropping the candidate', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'knowledge-filing-none-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const failureCases = new FailureCaseStore(directory);
  await failureCases.initialize();
  const engine = new PromotionEngine({
    dataDirectory: directory,
    policyPath: path.resolve('config/promotion-policy.json'),
    failureCases,
    harnessRegistry: { list: async () => [] },
    skillRegistry: { list: async () => [] },
  });
  await engine.initialize();
  await assert.rejects(() => engine.fileAsKnowledge(ACTOR, UNDECIDABLE, CASES), /No wiki store/);
});
