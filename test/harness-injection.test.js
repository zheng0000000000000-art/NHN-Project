import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { INJECTIONS, runInjection, simulateInjections, unprovenHarnesses } from '../tools/verification/check-harness-injection.mjs';

const GIT = process.env.TEAM_LOOP_GIT_BIN || 'git';

// 주입 대상 파일과 가짜 하네스를 갖춘 임시 저장소를 만든다.
async function sandbox(t, harnessBody) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harness-injection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'tools', 'verification'), { recursive: true });
  await writeFile(path.join(root, 'subject.txt'), 'healthy\n', 'utf8');
  await writeFile(path.join(root, 'tools', 'verification', 'check-fake.mjs'), harnessBody, 'utf8');
  const run = (...args) => execFileSync(GIT, ['-c', 'user.email=h@e.com', '-c', 'user.name=h', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' });
  run('init', '-q');
  run('add', '-A');
  run('commit', '-qm', 'init');
  return root;
}

const WATCHFUL = `import { readFileSync } from 'node:fs';
process.exit(readFileSync('subject.txt', 'utf8').includes('healthy') ? 0 : 1);
`;
const BLIND = 'process.exit(0);\n';

const SPEC = {
  harness: 'tools/verification/check-fake.mjs',
  contract: 'fake',
  name: 'subject-broken',
  file: 'subject.txt',
  mutate: () => 'broken\n',
};

test('a harness that catches its injected fault is proven', async (t) => {
  const root = await sandbox(t, WATCHFUL);
  const result = runInjection(SPEC, root);
  assert.equal(result.injectedExit, 1);
  assert.equal(result.restoredExit, 0);
  assert.equal(result.caught, true);
  assert.equal(readFileSync(path.join(root, 'subject.txt'), 'utf8'), 'healthy\n', 'the subject must be restored');
});

test('a harness that passes while the fault is present is reported as missed', async (t) => {
  const root = await sandbox(t, BLIND);
  const result = runInjection(SPEC, root);
  assert.equal(result.injectedExit, 0);
  assert.equal(result.caught, false);
  assert.match(result.detail, /passed while the fault was present/);
});

test('a stale injection spec that changes nothing is not counted as proof', async (t) => {
  const root = await sandbox(t, WATCHFUL);
  const result = runInjection({ ...SPEC, mutate: (text) => text }, root);
  assert.equal(result.caught, false);
  assert.match(result.detail, /changed nothing/);
});

test('injection is refused while the target file has uncommitted changes', async (t) => {
  const root = await sandbox(t, WATCHFUL);
  await writeFile(path.join(root, 'subject.txt'), 'edited by someone else\n', 'utf8');
  const report = simulateInjections(root, [SPEC]);
  assert.equal(report.skipped, true);
  assert.equal(report.results.length, 0);
  assert.ok(report.dirty.length > 0);
  assert.equal(readFileSync(path.join(root, 'subject.txt'), 'utf8'), 'edited by someone else\n', 'the other edit must survive');
});

test('unproven harnesses are derived from the directory, not maintained by hand', async (t) => {
  const root = await sandbox(t, WATCHFUL);
  assert.deepEqual(unprovenHarnesses(root, []), ['tools/verification/check-fake.mjs']);
  assert.deepEqual(unprovenHarnesses(root, [SPEC]), []);
});

test('every injection spec names a harness that exists', () => {
  const covered = new Set(unprovenHarnesses(process.cwd(), []));
  for (const injection of INJECTIONS) {
    assert.ok(covered.has(injection.harness), `${injection.harness} must exist in tools/verification`);
  }
});
