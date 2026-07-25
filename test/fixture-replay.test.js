import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { HarnessRegistry } from '../src/harness-registry.js';

async function registry(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fixture-replay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seed = path.join(root, 'profiles.json');
  await writeFile(seed, JSON.stringify({
    schemaVersion: 1,
    profiles: {
      'token-efficiency-regression': {
        label: 'Token efficiency regression',
        commands: [{ file: 'node', args: ['tools/verification/check-token-efficiency.mjs'], expectedExit: 0 }],
      },
      'unrelated-profile': {
        label: 'Unrelated',
        commands: [{ file: 'node', args: ['tools/verification/check-writing.mjs', 'document'], expectedExit: 0 }],
      },
    },
  }));
  const harnessRegistry = new HarnessRegistry({ dataDirectory: path.join(root, 'data'), seedProfilePath: seed, workspaceRoot: root });
  await harnessRegistry.initialize();
  return harnessRegistry;
}

const FAILURE = { id: 'fail_abcdef0123456789', kind: 'EXIT_MISMATCH', signatureSha256: 'a'.repeat(64) };

test('a fresh fixture candidate is not replay ready and says what is missing', async (t) => {
  const harnesses = await registry(t);
  const candidate = await harnesses.addFixtureCandidate('token-efficiency-regression', FAILURE, 'owner');
  assert.equal(candidate.replayReady, false);
  assert.match(candidate.replayBlocker, /have not been supplied/);
});

test('a caught injection is the only thing that makes a fixture replay ready', async (t) => {
  const harnesses = await registry(t);
  const candidate = await harnesses.addFixtureCandidate('token-efficiency-regression', FAILURE, 'owner');

  const proven = await harnesses.recordFixtureReplay('token-efficiency-regression', candidate.id, {
    name: 'turn-ceiling-removed', injectedExit: 1, restoredExit: 0, caught: true,
  }, 'owner');
  assert.equal(proven.replayReady, true);
  assert.equal(proven.replayBlocker, null);
  assert.equal(proven.status, 'READY');
  assert.equal(proven.lastReplay.injection, 'turn-ceiling-removed');
  assert.equal(proven.lastReplay.injectedExit, 1);
  assert.equal(proven.lastReplay.restoredExit, 0);
});

test('an escaped fault turns replay readiness back off and records why', async (t) => {
  const harnesses = await registry(t);
  const candidate = await harnesses.addFixtureCandidate('token-efficiency-regression', FAILURE, 'owner');
  await harnesses.recordFixtureReplay('token-efficiency-regression', candidate.id, { name: 'x', caught: true }, 'owner');

  const regressed = await harnesses.recordFixtureReplay('token-efficiency-regression', candidate.id, {
    name: 'turn-ceiling-removed', injectedExit: 0, restoredExit: 0, caught: false,
    detail: 'the harness passed while the fault was present',
  }, 'owner');
  assert.equal(regressed.replayReady, false, 'proof must not be sticky once it stops holding');
  assert.match(regressed.replayBlocker, /passed while the fault was present/);
  assert.equal(regressed.status, 'DRAFT');
});

test('recording a replay against an unknown harness or candidate is refused', async (t) => {
  const harnesses = await registry(t);
  await assert.rejects(() => harnesses.recordFixtureReplay('nope', 'fxc_1', { caught: true }, 'owner'), /Harness not found/);
  await assert.rejects(
    () => harnesses.recordFixtureReplay('token-efficiency-regression', 'fxc_missing', { caught: true }, 'owner'),
    /Fixture candidate not found/,
  );
});

test('an injection script maps back to the harnesses that run it', async (t) => {
  const harnesses = await registry(t);
  const matched = await harnesses.findByCommandScript('tools/verification/check-token-efficiency.mjs');
  assert.deepEqual(matched.map((item) => item.id), ['token-efficiency-regression']);

  const other = await harnesses.findByCommandScript('tools/verification/check-writing.mjs');
  assert.deepEqual(other.map((item) => item.id), ['unrelated-profile']);

  assert.deepEqual(await harnesses.findByCommandScript('tools/verification/check-nothing.mjs'), []);
  assert.deepEqual(await harnesses.findByCommandScript(''), []);
});
