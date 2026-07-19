import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

test('legacy reissued DONE task archives and links its original during migration', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-supersession-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'users.json'), JSON.stringify({ schemaVersion: 1, users: [] }));
  await writeFile(path.join(root, 'tasks.json'), JSON.stringify({ schemaVersion: 1, tasks: [
    { id: 'tsk_old', title: '[B01] old', status: 'READY', archived: false, version: 1 },
    { id: 'tsk_new', title: '[B01R] new', description: 'tsk_old(B01) 재발행', status: 'DONE', archived: true, version: 2 },
  ] }));
  await new Store(root).initialize();
  const tasks = JSON.parse(await readFile(path.join(root, 'tasks.json'), 'utf8')).tasks;
  assert.equal(tasks[0].archived, true);
  assert.equal(tasks[0].supersededByTaskId, 'tsk_new');
  assert.equal(tasks[1].supersedesTaskId, 'tsk_old');
});

test('finalizing an explicit replacement archives the original', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-supersession-finalize-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'users.json'), JSON.stringify({ schemaVersion: 1, users: [] }));
  await writeFile(path.join(root, 'tasks.json'), JSON.stringify({ schemaVersion: 1, tasks: [
    { id: 'tsk_old', title: 'old', status: 'READY', archived: false, version: 1 },
    { id: 'tsk_new', title: 'new', status: 'DONE', supersedesTaskId: 'tsk_old', archived: false, version: 2 },
  ] }));
  const store = new Store(root);
  await store.initialize();
  await store.finalizeSupersession(await store.getTask('tsk_new'), { id: 'usr_admin' });
  const old = await store.getTask('tsk_old');
  assert.equal(old.archived, true);
  assert.equal(old.supersededByTaskId, 'tsk_new');
});
