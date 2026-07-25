import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ContextPackStore, ContextSeedRegistry } from '../src/context-packs.js';
import { sha256 } from '../src/utils.js';

test('context seeds define reusable budget and layer policies', async () => {
  const registry = new ContextSeedRegistry(path.resolve('config/context-seeds.json'));
  await registry.initialize();
  const seeds = registry.list();
  assert.ok(seeds.length >= 3);
  assert.ok(seeds.every((seed) => seed.maxSourceCharacters > 0 && seed.layers.length > 0));
});

test('locking a context pack verifies inputs and records serialized evidence', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'context-pack-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'source.md'), 'verified source', 'utf8');
  const store = new ContextPackStore({ dataDirectory: directory, workspaceRoot: directory });
  await store.initialize();
  const actor = { id: 'owner', role: 'member' };
  const seed = { id: 'test', label: 'Test', maxSourceCharacters: 1000, layers: ['L0', 'L1'] };
  const pack = {
    goal: 'Verify receipt',
    contract: {
      packId: 'receipt-test',
      requiredInputs: [{ path: 'source.md', sha256: sha256('verified source') }],
      readOrder: ['source.md'],
      writeScope: [],
      forbiddenActions: [],
    },
    sources: {
      sources: [{ path: 'source.md', chunk: 0, text: 'verified source' }],
      sourceCount: 1,
      characters: 15,
      estimatedTokens: 4,
      budgetCharacters: 1000,
    },
  };
  const record = await store.record(actor, seed, pack);
  const locked = await store.lockPack(record.id, actor);
  assert.equal(locked.status, 'LOCKED');
  assert.equal(locked.receipt.integrity.ok, true);
  assert.equal(locked.receipt.stages.serialized, true);
  assert.equal(locked.receipt.stages.transported, false);
  assert.equal(locked.receipt.requiredInputs[0].includedInModelRequest, true);
});

test('recording a context pack requires and stores a rationale for a budget increase', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'context-pack-budget-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ContextPackStore({ dataDirectory: directory, workspaceRoot: directory });
  await store.initialize();
  const actor = { id: 'owner', role: 'member' };
  const seed = { id: 'test', label: 'Test', maxSourceCharacters: 1000, layers: ['L0'] };
  const pack = {
    goal: 'Increase budget',
    contract: { packId: 'budget-test', requiredInputs: [], readOrder: [], writeScope: [], forbiddenActions: [] },
    sources: { sources: [], sourceCount: 0, characters: 0, estimatedTokens: 0, budgetCharacters: 2000 },
  };
  await assert.rejects(() => store.record(actor, seed, pack, { rationale: '' }), (error) => error.status === 400);
  const record = await store.record(actor, seed, pack, { rationale: 'Need more headroom for a large migration.' });
  assert.equal(record.budgetRationale, 'Need more headroom for a large migration.');
});

test('locking fails closed when a declared input becomes stale', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'context-pack-stale-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'source.md'), 'new source', 'utf8');
  const store = new ContextPackStore({ dataDirectory: directory, workspaceRoot: directory });
  await store.initialize();
  const record = await store.record(
    { id: 'owner', role: 'member' },
    { id: 'test', label: 'Test', maxSourceCharacters: 1000, layers: [] },
    {
      goal: 'Reject stale',
      contract: { packId: 'stale', requiredInputs: [{ path: 'source.md', sha256: sha256('old source') }], readOrder: ['source.md'], writeScope: [], forbiddenActions: [] },
      sources: { sources: [{ path: 'source.md', chunk: 0, text: 'old source' }], sourceCount: 1, characters: 10, estimatedTokens: 3, budgetCharacters: 1000 },
    },
  );
  await assert.rejects(() => store.lockPack(record.id, { id: 'owner', role: 'member' }), (error) => error.status === 409);
});
