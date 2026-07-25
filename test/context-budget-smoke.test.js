import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ContextSeedRegistry } from '../src/context-packs.js';

test('implementation context seed stays within its declared 12000-character source budget', async () => {
  const registry = new ContextSeedRegistry(path.resolve('config/context-seeds.json'));
  await registry.initialize();
  const seed = registry.get('implementation');
  assert.ok(seed, 'implementation seed must exist');
  assert.equal(seed.maxSourceCharacters, 12000);
});
