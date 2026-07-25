import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTaskWorktree, commitTaskWorktree, mergePreparedWorktree, removeTaskWorktree, listTaskWorktrees, taskBranchMerged, worktreeBranch, worktreeHasChanges } from '../src/worktree.js';

function gitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-repo-'));
  const run = (...args) => spawnSync('git', args, { cwd: dir });
  run('init', '-q');
  run('config', 'user.email', 'a@b');
  run('config', 'user.name', 'a');
  fs.writeFileSync(path.join(dir, 'main.txt'), 'main file');
  run('add', '-A');
  run('commit', '-q', '-m', 'init');
  return dir;
}

test('per-task worktree physically isolates edits from the main tree', async () => {
  const repo = gitRepo();
  try {
    const original = fs.readFileSync(path.join(repo, 'main.txt'), 'utf8');
    const { dir, branch } = await createTaskWorktree(repo, 'tsk_ABC');
    assert.equal(branch, worktreeBranch('tsk_ABC'));
    assert.ok(fs.existsSync(dir));

    // An agent working in the task worktree edits files there.
    fs.writeFileSync(path.join(dir, 'agent-file.txt'), 'by agent');
    fs.writeFileSync(path.join(dir, 'main.txt'), 'AGENT CHANGED THIS');

    // The main working tree is physically unaffected.
    assert.ok(!fs.existsSync(path.join(repo, 'agent-file.txt')), 'agent file must not leak to main tree');
    assert.equal(fs.readFileSync(path.join(repo, 'main.txt'), 'utf8'), original, 'main tree file unchanged');
    // The worktree keeps its own edit.
    assert.equal(fs.readFileSync(path.join(dir, 'main.txt'), 'utf8'), 'AGENT CHANGED THIS');

    const list = await listTaskWorktrees(repo);
    assert.ok(list.some((entry) => entry.branch === worktreeBranch('tsk_ABC')));

    await removeTaskWorktree(repo, 'tsk_ABC');
    assert.ok(!fs.existsSync(dir), 'worktree removed on cleanup');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('createTaskWorktree is idempotent (recreate resets cleanly)', async () => {
  const repo = gitRepo();
  try {
    await createTaskWorktree(repo, 'tsk_X');
    // second call must not throw even though the worktree/branch already exist
    const { dir } = await createTaskWorktree(repo, 'tsk_X');
    assert.ok(fs.existsSync(dir));
    await removeTaskWorktree(repo, 'tsk_X');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('detects unlanded worktree changes before archive', async () => {
  const repo = gitRepo();
  try {
    const { dir } = await createTaskWorktree(repo, 'tsk_DIRTY');
    assert.equal(await worktreeHasChanges(repo, 'tsk_DIRTY'), false);
    fs.writeFileSync(path.join(dir, 'result.txt'), 'unlanded result');
    assert.equal(await worktreeHasChanges(repo, 'tsk_DIRTY'), true);
    await removeTaskWorktree(repo, 'tsk_DIRTY');
    assert.equal(await worktreeHasChanges(repo, 'tsk_DIRTY'), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('detects a task branch that was manually integrated before approval', async () => {
  const repo = gitRepo();
  try {
    const { dir } = await createTaskWorktree(repo, 'tsk_MANUAL');
    fs.writeFileSync(path.join(dir, 'result.txt'), 'integrated result');
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'task result'], { cwd: dir });
    assert.equal(await taskBranchMerged(repo, 'tsk_MANUAL'), false);
    spawnSync('git', ['merge', '--no-ff', worktreeBranch('tsk_MANUAL'), '-m', 'manual integration'], { cwd: repo });
    assert.equal(await taskBranchMerged(repo, 'tsk_MANUAL'), true);
    await removeTaskWorktree(repo, 'tsk_MANUAL');
    assert.equal(await taskBranchMerged(repo, 'tsk_MANUAL'), true);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('sanitizes task id and rejects empty', async () => {
  await assert.rejects(() => createTaskWorktree('/tmp', ''), /Task id is required/);
});

test('a conflicting merge is aborted so the integration tree never keeps conflict markers', async () => {
  const repo = gitRepo();
  const run = (...args) => spawnSync('git', args, { cwd: repo });
  try {
    const { dir } = await createTaskWorktree(repo, 'tsk_CONFLICT');
    fs.writeFileSync(path.join(dir, 'main.txt'), 'written by the task worktree');
    await commitTaskWorktree(repo, 'tsk_CONFLICT', { message: 'task edit', remove: false });

    // The integration tree moves on independently, so the same file diverges.
    fs.writeFileSync(path.join(repo, 'main.txt'), 'written on the integration branch');
    run('add', '-A');
    run('commit', '-q', '-m', 'integration edit');

    await assert.rejects(
      () => mergePreparedWorktree(repo, 'tsk_CONFLICT'),
      /merge/i,
      'a conflicting merge must still surface as a delivery failure',
    );

    assert.ok(!fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD')), 'no merge may be left in progress');
    assert.ok(
      !fs.readFileSync(path.join(repo, 'main.txt'), 'utf8').includes('<<<<<<<'),
      'no conflict marker may be left in the integration tree',
    );
    assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).stdout.trim(), '');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
