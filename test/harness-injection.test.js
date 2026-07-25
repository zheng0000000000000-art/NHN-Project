import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import {
  INJECTIONS,
  PROVEN_ELSEWHERE,
  createSandbox,
  detectIdle,
  removeSandbox,
  runInjection,
  simulateInjections,
  unprovenHarnesses,
} from '../tools/verification/check-harness-injection.mjs';

const GIT = process.env.TEAM_LOOP_GIT_BIN || 'git';

// 주입 대상과 가짜 하네스를 갖춘 임시 저장소를 만든다.
async function sandboxRepo(t, harnessBody) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harness-injection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'tools', 'verification'), { recursive: true });
  await writeFile(path.join(root, 'subject.txt'), 'healthy\n', 'utf8');
  await writeFile(path.join(root, 'tools', 'verification', 'check-fake.mjs'), harnessBody, 'utf8');
  const run = (...args) => execFileSync(GIT, ['-c', 'user.email=h@e.com', '-c', 'user.name=h', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
  const root = await sandboxRepo(t, WATCHFUL);
  const result = runInjection(SPEC, root);
  assert.equal(result.injectedExit, 1);
  assert.equal(result.restoredExit, 0);
  assert.equal(result.caught, true);
  assert.equal(readFileSync(path.join(root, 'subject.txt'), 'utf8'), 'healthy\n', 'the subject must be restored');
});

test('a harness that passes while the fault is present is reported as missed', async (t) => {
  const root = await sandboxRepo(t, BLIND);
  const result = runInjection(SPEC, root);
  assert.equal(result.injectedExit, 0);
  assert.equal(result.caught, false);
  assert.match(result.detail, /passed while the fault was present/);
});

test('a stale injection spec that changes nothing is not counted as proof', async (t) => {
  const root = await sandboxRepo(t, WATCHFUL);
  const result = runInjection({ ...SPEC, mutate: (text) => text }, root);
  assert.equal(result.caught, false);
  assert.match(result.detail, /changed nothing/);
});

test('faults are injected into a sandbox worktree, never into the live tree', async (t) => {
  const root = await sandboxRepo(t, WATCHFUL);
  const report = simulateInjections(root, [SPEC]);
  assert.equal(report.skipped, false);
  assert.equal(report.results[0].caught, true);
  assert.notEqual(report.sandbox.root, root, 'the sandbox must be a separate directory');
  assert.ok(report.sandbox.baseFingerprint.length >= 7, 'the snapshot must record its base commit');
  assert.equal(readFileSync(path.join(root, 'subject.txt'), 'utf8'), 'healthy\n', 'the live tree must be untouched');
  assert.equal(report.cleanup.removed, true, 'a clean run removes its sandbox');
  assert.ok(!existsSync(report.sandbox.root));
});

test('a sandbox is preserved for inspection when a fault escapes', async (t) => {
  const root = await sandboxRepo(t, BLIND);
  const report = simulateInjections(root, [SPEC]);
  assert.equal(report.results[0].caught, false);
  assert.equal(report.cleanup.preserved, report.sandbox.root);
  assert.ok(existsSync(report.sandbox.root), 'the workspace under investigation must not be deleted');
  assert.equal(removeSandbox(root).removed, true, 'and it must still be removable afterwards');
});

test('uncommitted work is reported as not covered, because the sandbox is a HEAD snapshot', async (t) => {
  const root = await sandboxRepo(t, WATCHFUL);
  await writeFile(path.join(root, 'subject.txt'), 'edited but not committed\n', 'utf8');
  const report = simulateInjections(root, [SPEC]);
  assert.ok(report.untested.some((entry) => entry.includes('subject.txt')));
  assert.equal(readFileSync(path.join(root, 'subject.txt'), 'utf8'), 'edited but not committed\n', 'the other edit must survive');
});

test('a workspace with an active task worktree is not idle', async (t) => {
  const root = await sandboxRepo(t, WATCHFUL);
  assert.equal(detectIdle(root).idle, true);
  const taskTree = path.join(root, '.team-loop-worktrees', 'tsk_busy');
  execFileSync(GIT, ['worktree', 'add', '--detach', '--quiet', taskTree, 'HEAD'], { cwd: root, stdio: 'ignore' });
  const busy = detectIdle(root);
  assert.equal(busy.idle, false);
  assert.equal(busy.reason, 'TASK_WORKTREE_ACTIVE');
  const skipped = simulateInjections(root, [SPEC], { requireIdle: true });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.results.length, 0);
});

test('sandbox creation is idempotent and cleanup reports its own failure honestly', async (t) => {
  const root = await sandboxRepo(t, WATCHFUL);
  const first = createSandbox(root);
  assert.ok(existsSync(first.root));
  const second = createSandbox(root);
  assert.equal(second.root, first.root, 'recreating must reuse the same path, not pile up');
  assert.equal(removeSandbox(root).removed, true);
  assert.deepEqual(removeSandbox(root), { removed: false, error: null }, 'removing what is gone is not a failure');
});

test('unproven harnesses are derived, and harnesses proven elsewhere are not called unproven', async (t) => {
  const root = await sandboxRepo(t, WATCHFUL);
  assert.deepEqual(unprovenHarnesses(root, []), ['tools/verification/check-fake.mjs']);
  assert.deepEqual(unprovenHarnesses(root, [SPEC]), []);
  const unproven = unprovenHarnesses(process.cwd(), INJECTIONS);
  for (const harness of Object.keys(PROVEN_ELSEWHERE)) {
    assert.ok(!unproven.includes(harness), `${harness} is proven elsewhere and must not be listed as unproven`);
  }
});

test('every injection spec names a harness that exists', () => {
  const present = new Set(unprovenHarnesses(process.cwd(), []));
  for (const injection of INJECTIONS) {
    assert.ok(present.has(injection.harness), `${injection.harness} must exist in tools/verification`);
  }
});
