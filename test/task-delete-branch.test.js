import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  createTaskWorktree,
  removeTaskBranch,
  removeTaskWorktree,
  taskBranchExists,
  worktreeBranch,
} from '../src/worktree.js';

const GIT = process.env.TEAM_LOOP_GIT_BIN || 'git';

// 커밋까지 가능한 임시 저장소 하나. 태스크 삭제가 브랜치를 어떻게 다루는지만 본다.
async function tempRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-delete-branch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = (...args) => execFileSync(GIT, [
    '-c', 'user.email=harness@example.com',
    '-c', 'user.name=harness',
    '-c', 'commit.gpgsign=false',
    ...args,
  ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  run('init', '-q');
  await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8');
  run('add', '.');
  run('commit', '-q', '-m', 'base');
  return { root, run };
}

// 태스크 worktree 안에서 커밋을 하나 만든다. 이 커밋은 HEAD에서 닿지 않는다.
async function commitInWorktree(root, taskId, contents) {
  const { dir } = await createTaskWorktree(root, taskId);
  await writeFile(path.join(dir, 'work.txt'), contents, 'utf8');
  // work.txt는 새 파일이라 `commit -a`로는 담기지 않는다. 먼저 스테이지에 올린다.
  const inWorktree = (...args) => execFileSync(GIT, [
    '-c', 'user.email=harness@example.com',
    '-c', 'user.name=harness',
    '-c', 'commit.gpgsign=false',
    ...args,
  ], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  inWorktree('add', '-A');
  inWorktree('commit', '-q', '-m', 'unlanded work');
  const commit = inWorktree('rev-parse', 'HEAD').trim();
  await removeTaskWorktree(root, taskId);
  return commit;
}

test('a branch holding commits unreachable from HEAD is refused, not deleted', async (t) => {
  const { root, run } = await tempRepository(t);
  const taskId = 'tsk_unlanded';
  const commit = await commitInWorktree(root, taskId, 'work that never landed\n');

  await assert.rejects(
    () => removeTaskBranch(root, taskId),
    /not reachable from HEAD/,
    'unlanded work must not be destroyed by a task delete',
  );

  assert.equal(await taskBranchExists(root, taskId), true, 'the branch must survive the refusal');
  assert.equal(
    run('rev-parse', worktreeBranch(taskId)).trim(),
    commit,
    'the unlanded commit must still be reachable from the branch',
  );
});

test('a branch whose commits are all reachable from HEAD is removed', async (t) => {
  const { root, run } = await tempRepository(t);
  const taskId = 'tsk_landed';
  await commitInWorktree(root, taskId, 'work that landed\n');
  run('merge', '--no-ff', '-q', '-m', 'merge task', worktreeBranch(taskId));

  const outcome = await removeTaskBranch(root, taskId);
  assert.equal(outcome.removed, true);
  assert.equal(outcome.absent, undefined);
  assert.equal(outcome.error, null);
  assert.equal(outcome.branch, worktreeBranch(taskId));
  assert.equal(await taskBranchExists(root, taskId), false, 'the merged branch must be gone');
});

test('a task that never had a branch is nothing to clean, not a failure', async (t) => {
  const { root } = await tempRepository(t);

  const outcome = await removeTaskBranch(root, 'tsk_never');
  assert.equal(outcome.absent, true);
  assert.equal(outcome.removed, false);
  assert.equal(outcome.error, null, 'an absent branch must not be reported as a cleanup failure');
});

// "no such branch" is one specific git answer, not every way git can fail. A repository
// git cannot read at all says nothing about whether the branch holds unlanded work, so
// it must surface as a cleanup failure the caller records — never as nothing to clean.
test('a git failure is not mistaken for an absent branch', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-delete-branch-broken-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // A .git file with a garbage gitdir pointer fails the same way from any parent
  // directory, so this does not depend on where the temp directory happens to live.
  await writeFile(path.join(root, '.git'), 'gitdir: /nonexistent/not-a-repo\n', 'utf8');

  await assert.rejects(
    () => taskBranchExists(root, 'tsk_broken'),
    /git rev-parse/,
    'an unreadable repository must not answer "no such branch"',
  );
  await assert.rejects(() => removeTaskBranch(root, 'tsk_broken'), /git rev-parse/);
});
