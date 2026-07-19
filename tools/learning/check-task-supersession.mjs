import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../src/store.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-supersession-'));
try {
  const original = { id: 'tsk_original', title: '[B01] Original', status: 'READY', archived: false, version: 1 };
  const replacement = {
    id: 'tsk_replacement', title: '[B01R] Replacement', status: 'DONE', archived: true, version: 4,
    description: 'tsk_original(B01) 재발행. 범위 확장.', completedAt: '2026-07-20T00:00:00.000Z',
    review: { reviewerUserId: 'usr_admin' },
  };
  await writeFile(path.join(root, 'users.json'), JSON.stringify({ schemaVersion: 1, users: [] }), 'utf8');
  await writeFile(path.join(root, 'tasks.json'), JSON.stringify({ schemaVersion: 1, tasks: [original, replacement] }), 'utf8');
  const store = new Store(root);
  await store.initialize();
  const tasks = JSON.parse(await readFile(path.join(root, 'tasks.json'), 'utf8')).tasks;
  const migratedOriginal = tasks.find((task) => task.id === original.id);
  const migratedReplacement = tasks.find((task) => task.id === replacement.id);
  assert.equal(migratedReplacement.supersedesTaskId, original.id);
  assert.equal(migratedOriginal.archived, true);
  assert.equal(migratedOriginal.supersededByTaskId, replacement.id);
  process.stdout.write('task supersession regression passed\n');
} finally {
  await rm(root, { recursive: true, force: true });
}
