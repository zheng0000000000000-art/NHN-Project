import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { applyRemoteTaskSubmission, projectHead, readRemoteTaskFiles } from '../src/remote-submission.js';
import { removeTaskWorktree, worktreePath } from '../src/worktree.js';

function gitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-submit-'));
  const run = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  run('init', '-q');
  run('config', 'user.email', 'a@b');
  run('config', 'user.name', 'a');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'private reference\n');
  run('add', '-A');
  run('commit', '-q', '-m', 'init');
  return dir;
}

const task = { id: 'tsk_REMOTE', status: 'IN_PROGRESS', allowedPaths: ['src/**'] };

test('remote agents read and submit only scoped text files into a server worktree', async () => {
  const repo = gitRepo();
  try {
    const read = await readRemoteTaskFiles(repo, task, ['src/app.js', 'src/new.js']);
    assert.match(read.files[0].content, /value = 1/);
    assert.equal(read.files[1].missing, true);
    const result = await applyRemoteTaskSubmission(repo, task, {
      baseCommit: read.baseCommit,
      summary: 'Update app and add helper',
      learningDisposition: 'No reusable failure.',
      files: [
        { path: 'src/app.js', content: 'export const value = 2;\n' },
        { path: 'src/new.js', content: 'export const added = true;\n' },
      ],
    });
    assert.equal(result.files.length, 2);
    assert.equal(fs.readFileSync(path.join(worktreePath(repo, task.id), 'src', 'app.js'), 'utf8'), 'export const value = 2;\n');
    assert.equal(fs.readFileSync(path.join(repo, 'src', 'app.js'), 'utf8'), 'export const value = 1;\n');
    const submittedTask = { ...task, delivery: { type: 'MCP_FILES', branch: result.branch } };
    const reread = await readRemoteTaskFiles(repo, submittedTask, ['src/app.js']);
    assert.match(reread.files[0].content, /value = 2/);
    await applyRemoteTaskSubmission(repo, submittedTask, {
      baseCommit: reread.baseCommit,
      summary: 'Fix after verification',
      learningDisposition: 'Reused the existing task evidence.',
      files: [{ path: 'src/app.js', content: 'export const value = 3;\n' }],
    });
    assert.equal(fs.readFileSync(path.join(worktreePath(repo, task.id), 'src', 'app.js'), 'utf8'), 'export const value = 3;\n');
    await removeTaskWorktree(repo, task.id);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('remote file access rejects scope escape, traversal, binary data, and stale bases', async () => {
  const repo = gitRepo();
  try {
    const baseCommit = await projectHead(repo);
    await assert.rejects(() => readRemoteTaskFiles(repo, task, ['README.md']), /outside task scope/);
    await assert.rejects(() => readRemoteTaskFiles(repo, { ...task, allowedPaths: ['**'] }, ['src/../README.md']), /Unsafe/);
    await assert.rejects(() => applyRemoteTaskSubmission(repo, task, {
      baseCommit, summary: 'x', learningDisposition: 'x', files: [{ path: 'src/app.js', content: 'bad\0data' }],
    }), /Binary content/);
    fs.writeFileSync(path.join(repo, 'README.md'), 'changed\n');
    spawnSync('git', ['add', '-A'], { cwd: repo });
    spawnSync('git', ['commit', '-q', '-m', 'move head'], { cwd: repo });
    await assert.rejects(() => applyRemoteTaskSubmission(repo, task, {
      baseCommit, summary: 'x', learningDisposition: 'x', files: [{ path: 'src/app.js', content: 'ok\n' }],
    }), /Project changed/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
