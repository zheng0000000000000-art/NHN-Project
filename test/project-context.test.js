import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectContextStore } from '../src/project-context.js';

test('project context is persisted for later AI requests', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'team-loop-context-'));
  try {
    const store = new ProjectContextStore(directory);
    await store.initialize();
    assert.deepEqual(await store.get(), {
      schemaVersion: 1,
      content: '',
      updatedAt: null,
      updatedByUserId: null,
    });

    const saved = await store.update({ id: 'usr_a' }, { content: 'Keep tasks small.' });
    assert.equal(saved.content, 'Keep tasks small.');
    assert.equal(saved.updatedByUserId, 'usr_a');
    assert.equal(typeof saved.updatedAt, 'string');

    const reloaded = new ProjectContextStore(directory);
    assert.equal((await reloaded.get()).content, 'Keep tasks small.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
