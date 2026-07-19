import test from 'node:test';
import assert from 'node:assert/strict';
import { globMatch, runProcess } from '../src/verifier.js';

test('glob matcher supports recursive and single-segment patterns', () => {
  assert.equal(globMatch('Game/Player/**', 'Game/Player/Movement/controller.cs'), true);
  assert.equal(globMatch('Game/*.cs', 'Game/Main.cs'), true);
  assert.equal(globMatch('Game/*.cs', 'Game/UI/Main.cs'), false);
  assert.equal(globMatch('**', 'anything/goes.txt'), true);
});

test('process runner uses exit code as verdict', async () => {
  const result = await runProcess({
    file: process.execPath,
    args: ['-e', 'process.exit(3)'],
    cwd: process.cwd(),
    expectedExit: 3,
    timeoutMs: 5000,
  });
  assert.equal(result.actualExit, 3);
  assert.equal(result.passed, true);
});

test('process runner fails closed on timeout', async () => {
  const result = await runProcess({
    file: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 5000)'],
    cwd: process.cwd(),
    expectedExit: 0,
    timeoutMs: 50,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.passed, false);
});

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Verifier } from '../src/verifier.js';

const execFile = promisify(execFileCallback);

test('verifier binds command pass to git scope', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-verifier-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFile('git', ['init', '-q'], { cwd: root });
  await execFile('git', ['config', 'user.name', 'Test'], { cwd: root });
  await execFile('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  await writeFile(path.join(root, 'game.js'), 'export const hp = 10;\n');
  await writeFile(path.join(root, 'profiles.json'), JSON.stringify({
    schemaVersion: 1,
    profiles: {
      test: {
        commands: [{ file: process.execPath, args: ['-e', 'process.exit(0)'], expectedExit: 0, timeoutMs: 5000 }],
      },
    },
  }));
  await execFile('git', ['add', '.'], { cwd: root });
  await execFile('git', ['commit', '-qm', 'initial'], { cwd: root });
  await writeFile(path.join(root, 'game.js'), 'export const hp = 20;\n');

  const verifier = new Verifier({ workspaceRoot: root, profilePath: path.join(root, 'profiles.json') });
  const pass = await verifier.run({ verificationProfile: 'test', allowedPaths: ['game.js'] });
  assert.equal(pass.passed, true);
  assert.deepEqual(pass.changedPaths, ['game.js']);

  const fail = await verifier.run({ verificationProfile: 'test', allowedPaths: ['ui/**'] });
  assert.equal(fail.passed, false);
  assert.deepEqual(fail.scopeViolations, ['game.js']);
});

test('teamLoopRoot placeholders resolve to the tool runtime rather than an external workspace', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'team-loop-external-workspace-'));
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'team-loop-runtime-root-'));
  t.after(() => Promise.all([rm(workspace, { recursive: true, force: true }), rm(runtime, { recursive: true, force: true })]));
  await execFile('git', ['init', '-q'], { cwd: workspace });
  await execFile('git', ['config', 'user.name', 'Test'], { cwd: workspace });
  await execFile('git', ['config', 'user.email', 'test@example.invalid'], { cwd: workspace });
  await writeFile(path.join(workspace, 'README.md'), 'external workspace\n');
  await writeFile(path.join(runtime, 'check.mjs'), 'process.exit(0);\n');
  const profiles = path.join(runtime, 'profiles.json');
  await writeFile(profiles, JSON.stringify({ schemaVersion: 1, profiles: { test: { commands: [
    { file: process.execPath, args: ['{teamLoopRoot}/check.mjs'], expectedExit: 0, timeoutMs: 5000 },
  ] } } }));
  await execFile('git', ['add', '.'], { cwd: workspace });
  await execFile('git', ['commit', '-qm', 'initial'], { cwd: workspace });
  const verifier = new Verifier({ workspaceRoot: workspace, runtimeRoot: runtime, profilePath: profiles });
  const result = await verifier.run({ verificationProfile: 'test', allowedPaths: ['**'] });
  assert.equal(result.passed, true);
  assert.equal(result.checks[0].args[0].replaceAll('\\', '/'), path.join(runtime, 'check.mjs').replaceAll('\\', '/'));
});

test('workspace verification mutex rejects a concurrent verification instead of queueing', async () => {
  const verifier = new Verifier({ workspaceRoot: process.cwd(), profilePath: path.join(process.cwd(), 'config', 'verification-profiles.json') });
  let releaseFirst;
  const firstStarted = new Promise((resolve) => { releaseFirst = resolve; });
  let enterFirst;
  const firstEntered = new Promise((resolve) => { enterFirst = resolve; });

  const first = verifier.withWorkspaceLock(async () => {
    enterFirst();
    await firstStarted;
    return 'done';
  });
  await firstEntered;
  await assert.rejects(
    () => verifier.withWorkspaceLock(async () => 'should-not-run'),
    (error) => error.status === 409 && error.message === 'Another verification is already running.',
  );
  releaseFirst();
  assert.equal(await first, 'done');
});
