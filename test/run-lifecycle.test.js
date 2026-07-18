import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli/main.js';

const execFile = promisify(execFileCallback);

test('run execute prepares a verified commit and run land merges only after approval', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-lifecycle-'));
  const previousBin = process.env.TEAM_LOOP_CUSTOM_EXECUTOR_BIN;
  const previousArgs = process.env.TEAM_LOOP_CUSTOM_EXECUTOR_ARGS;
  const originalWrite = process.stdout.write;
  try {
    await mkdir(path.join(root, 'config'), { recursive: true });
    await mkdir(path.join(root, '.team-loop', 'runs'), { recursive: true });
    await writeFile(path.join(root, '.gitignore'), '.team-loop/\n.team-loop-worktrees/\n');
    await writeFile(path.join(root, 'config', 'verification-profiles.json'), JSON.stringify({ schemaVersion: 1, profiles: { 'node-project': { commands: [{ file: process.execPath, args: ['--check', 'src/output.js'], expectedExit: 0 }] } } }));
    const runPath = path.join(root, '.team-loop', 'runs', 'isolated-run.json');
    await writeFile(runPath, JSON.stringify({ id: 'isolated-run', title: 'Isolated run', agent: 'tester', changes: [], writeScope: ['src/**'], verification: { profile: 'node-project' } }));
    await execFile('git', ['init', '-q'], { cwd: root });
    await execFile('git', ['config', 'user.name', 'Test'], { cwd: root });
    await execFile('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
    await execFile('git', ['add', '.'], { cwd: root });
    await execFile('git', ['commit', '-qm', 'initial'], { cwd: root });
    process.env.TEAM_LOOP_CUSTOM_EXECUTOR_BIN = process.execPath;
    process.env.TEAM_LOOP_CUSTOM_EXECUTOR_ARGS = JSON.stringify(['-e', "require('fs').mkdirSync('src',{recursive:true});require('fs').writeFileSync('src/output.js','export const ok = true;\\n')"]);
    process.stdout.write = () => true;
    const code = await runCli(['run', 'execute', runPath, '--workspace', root, '--executor', 'custom', '--execute', '--json']);
    assert.equal(code, 0);
    await assert.rejects(readFile(path.join(root, 'src', 'output.js'), 'utf8'), /ENOENT/);
    const result = JSON.parse(await readFile(path.join(root, '.team-loop', 'results', 'isolated-run', 'attempt-000001.json'), 'utf8'));
    assert.equal(result.verdict, 'PASSED');
    assert.equal(result.scopeLease.state, 'VERIFIED_AWAITING_APPROVAL');
    assert.match(await readFile(path.join(root, '.team-loop', 'results', 'isolated-run', 'events.jsonl'), 'utf8'), /VERIFIED_AWAITING_APPROVAL/);
    assert.equal((await execFile('git', ['worktree', 'list'], { cwd: root })).stdout.includes('.team-loop-worktrees'), false);
    assert.equal(await runCli(['run', 'land', 'isolated-run', '--workspace', root, '--json']), 0);
    assert.match(await readFile(path.join(root, 'src', 'output.js'), 'utf8'), /ok = true/);
    assert.match(await readFile(path.join(root, '.team-loop', 'results', 'isolated-run', 'events.jsonl'), 'utf8'), /"type":"LANDED"/);
  } finally {
    process.stdout.write = originalWrite;
    if (previousBin === undefined) delete process.env.TEAM_LOOP_CUSTOM_EXECUTOR_BIN; else process.env.TEAM_LOOP_CUSTOM_EXECUTOR_BIN = previousBin;
    if (previousArgs === undefined) delete process.env.TEAM_LOOP_CUSTOM_EXECUTOR_ARGS; else process.env.TEAM_LOOP_CUSTOM_EXECUTOR_ARGS = previousArgs;
    await rm(root, { recursive: true, force: true });
  }
});
