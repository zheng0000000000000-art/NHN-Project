import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { HarnessRegistry } from '../src/harness-registry.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-harness-'));
  const data = path.join(root, 'data');
  const seed = path.join(root, 'profiles.json');
  await writeFile(seed, JSON.stringify({ schemaVersion: 1, profiles: {
    builtin: { label: 'Built in', commands: [{ file: process.execPath, args: ['-e', 'process.exit(0)'] }] },
  } }));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new HarnessRegistry({ dataDirectory: data, seedProfilePath: seed, workspaceRoot: root });
  await registry.initialize();
  return { root, registry };
}

test('registry imports existing profiles as active built-in harnesses', async (t) => {
  const { registry } = await fixture(t);
  const item = await registry.get('builtin');
  assert.equal(item.status, 'ACTIVE');
  assert.equal(item.source, 'BUILTIN');
  assert.deepEqual(await registry.activeIds(), ['builtin']);
});

test('user harness must pass current definition before activation', async (t) => {
  const { registry } = await fixture(t);
  const actor = { id: 'usr_admin' };
  const created = await registry.create(actor, {
    id: 'node-pass', label: 'Node pass', commands: [{ file: process.execPath, args: ['-e', 'process.exit(0)'], cwd: '.', expectedExit: 0, timeoutMs: 5000 }],
  });
  assert.equal(created.status, 'DRAFT');
  await assert.rejects(() => registry.setStatus('node-pass', actor.id, created.version, 'ACTIVE'), /must pass a test/i);
  const tested = await registry.test('node-pass', actor.id);
  assert.equal(tested.test.passed, true);
  const active = await registry.setStatus('node-pass', actor.id, tested.harness.version, 'ACTIVE');
  assert.equal(active.status, 'ACTIVE');
});

test('harness rejects cwd escaping workspace', async (t) => {
  const { registry } = await fixture(t);
  await assert.rejects(() => registry.create({ id: 'usr_admin' }, {
    id: 'bad-cwd', label: 'Bad cwd', commands: [{ file: process.execPath, args: [], cwd: '../escape' }],
  }), /cannot escape/i);
});

test('failed harness test records exact exit result', async (t) => {
  const { registry } = await fixture(t);
  const created = await registry.create({ id: 'usr_admin' }, {
    id: 'node-fail', label: 'Node fail', commands: [{ file: process.execPath, args: ['-e', 'process.exit(7)'], expectedExit: 0, timeoutMs: 5000 }],
  });
  const tested = await registry.test(created.id, 'usr_admin');
  assert.equal(tested.test.passed, false);
  assert.equal(tested.test.checks[0].actualExit, 7);
  assert.equal(tested.test.checks[0].expectedExit, 0);
});
