// Per-task git worktree isolation.
//
// AI-first coordination has three layers of defense against agents stepping on each
// other: the claim-time scope lock (pre), the verifier's SCOPE_VIOLATION gate (post),
// and — strongest — physical isolation: each task gets its own git worktree + branch,
// so an agent literally cannot touch files outside its checkout. An orchestrator can
// dispatch an executor into the task's worktree, verify there, and discard it.

import { spawn } from 'node:child_process';
import path from 'node:path';

const WORKTREE_DIRNAME = '.team-loop-worktrees';

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.TEAM_LOOP_GIT_BIN || 'git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve(out.trim());
      // Callers that ask git a yes/no question need to tell "git answered no" apart from
      // "git could not answer" — carry the exit status and stderr, not just a message.
      const error = new Error(`git ${args.join(' ')} failed (exit ${code}): ${err.trim()}`);
      error.exitCode = code;
      error.stderr = err.trim();
      reject(error);
    });
  });
}

export function worktreePath(repoRoot, taskId) {
  return path.join(repoRoot, WORKTREE_DIRNAME, sanitizeTaskId(taskId));
}

export function worktreeBranch(taskId, prefix = 'task/') {
  return `${prefix}${sanitizeTaskId(taskId)}`;
}

// Create (or recreate) an isolated worktree + branch for a task. Returns { dir, branch }.
export async function createTaskWorktree(repoRoot, taskId, { base = 'HEAD', branchPrefix = 'task/' } = {}) {
  const dir = worktreePath(repoRoot, taskId);
  const branch = worktreeBranch(taskId, branchPrefix);
  await removeTaskWorktree(repoRoot, taskId).catch(() => {});
  // -B resets the branch to base if it already exists, so retries are clean.
  await git(['worktree', 'add', '-B', branch, dir, base], repoRoot);
  return { dir, branch };
}

export async function removeTaskWorktree(repoRoot, taskId) {
  const dir = worktreePath(repoRoot, taskId);
  await git(['worktree', 'remove', '--force', dir], repoRoot);
  return { dir };
}

export async function listTaskWorktrees(repoRoot) {
  const out = await git(['worktree', 'list', '--porcelain'], repoRoot);
  const entries = [];
  let current = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null };
      entries.push(current);
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).replace('refs/heads/', '');
    }
  }
  const marker = `${path.sep}${WORKTREE_DIRNAME}${path.sep}`;
  return entries.filter((entry) => entry.path.includes(WORKTREE_DIRNAME) || entry.path.includes(marker));
}

export async function worktreeHasChanges(repoRoot, taskId) {
  const dir = worktreePath(repoRoot, taskId);
  try {
    return Boolean((await git(['status', '--porcelain'], dir)).trim());
  } catch (error) {
    if (error?.code === 'ENOENT' || /cannot change to|not a working tree|No such file/i.test(error.message)) return false;
    throw error;
  }
}

// Only one kind of failure means "there is no such branch": `rev-parse --verify --quiet`
// exits 1 and says nothing when the ref is missing. Anything else — a broken repo (exit
// 128 with a fatal on stderr), a missing git binary (spawn ENOENT, no exit status) — is a
// question git could not answer, and reporting that as an absent branch would let the
// delete path treat a real error as nothing to clean. Those propagate.
export async function taskBranchExists(repoRoot, taskId) {
  try {
    await git(['rev-parse', '--verify', '--quiet', `refs/heads/${worktreeBranch(taskId)}`], repoRoot);
    return true;
  } catch (error) {
    if (error?.exitCode === 1 && !error.stderr) return false;
    throw error;
  }
}

export async function taskBranchMerged(repoRoot, taskId) {
  try {
    await git(['merge-base', '--is-ancestor', worktreeBranch(taskId), 'HEAD'], repoRoot);
    return true;
  } catch {
    return false;
  }
}

// Delete a task's branch — but only when it carries nothing that isn't already saved.
// A branch holding commits unreachable from HEAD is unlanded work, and deleting it
// loses that work permanently, so this refuses instead of forcing: the merged check is
// explicit and `git branch -d` (never `-D`) refuses on its own if the check is ever
// wrong. A task that never had a branch is nothing to clean, not a cleanup failure.
export async function removeTaskBranch(repoRoot, taskId) {
  const branch = worktreeBranch(taskId);
  if (!(await taskBranchExists(repoRoot, taskId))) return { branch, removed: false, error: null, absent: true };
  if (!(await taskBranchMerged(repoRoot, taskId))) {
    throw new Error(`Branch ${branch} has commits that are not reachable from HEAD.`);
  }
  await git(['branch', '-d', branch], repoRoot);
  return { branch, removed: true, error: null };
}

// Land a task's verified worktree changes into the repo's current branch: commit the
// working-tree changes onto task/<id>, merge (no-ff) into the main branch, then remove
// the worktree. Throws on merge conflict, and the conflicted merge is aborted first, so
// the caller reports a delivery failure against a clean tree rather than a half-merged one.
export async function mergeTaskWorktree(repoRoot, taskId, { message, trailers } = {}) {
  const branch = worktreeBranch(taskId);
  await commitTaskWorktree(repoRoot, taskId, { message, trailers });
  return mergePreparedWorktree(repoRoot, taskId, { trailers });
}

export async function commitTaskWorktree(repoRoot, taskId, { message, trailers, remove = false } = {}) {
  const branch = worktreeBranch(taskId);
  const dir = worktreePath(repoRoot, taskId);
  const subject = message || `team-loop: verify ${branch}`;
  const trailerLines = Object.entries(trailers || {}).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`);
  const commitMsg = trailerLines.length ? `${subject}\n\n${trailerLines.join('\n')}` : subject;
  await git(['add', '-A'], dir);
  const status = await git(['status', '--porcelain'], dir);
  if (status.trim()) {
    await git(['-c', 'user.email=team-loop@local', '-c', 'user.name=team-loop', 'commit', '-m', commitMsg], dir);
  }
  const commit = (await git(['rev-parse', 'HEAD'], dir)).trim();
  if (remove) await removeTaskWorktree(repoRoot, taskId);
  return { branch, commit, worktree: remove ? null : dir };
}

export async function mergePreparedWorktree(repoRoot, taskId, { trailers } = {}) {
  const branch = worktreeBranch(taskId);
  const trailerLines = Object.entries(trailers || {}).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`);
  const mergeMsg = trailerLines.length ? `Merge ${branch}\n\n${trailerLines.join('\n')}` : `Merge ${branch}`;
  // A conflicted merge must not survive the failure. Without the abort the integration
  // tree keeps conflict markers and a live MERGE_HEAD, while every task still verifies
  // green inside its own worktree — the breakage stays invisible until someone runs the
  // suite by hand. Delivery failure is still reported: the original error is rethrown.
  try {
    await git(['merge', '--no-ff', branch, '-m', mergeMsg], repoRoot);
  } catch (error) {
    await git(['merge', '--abort'], repoRoot).catch(() => {});
    throw error;
  }
  const head = (await git(['rev-parse', 'HEAD'], repoRoot)).trim();
  await removeTaskWorktree(repoRoot, taskId).catch(() => {});
  return { merged: true, branch, commit: head };
}

export function sanitizeTaskId(taskId) {
  const clean = String(taskId ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '');
  if (!clean) throw new Error('Task id is required for a worktree.');
  return clean;
}
