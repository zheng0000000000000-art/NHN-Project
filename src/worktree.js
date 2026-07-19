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
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`git ${args.join(' ')} failed (exit ${code}): ${err.trim()}`));
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

// Land a task's verified worktree changes into the repo's current branch: commit the
// working-tree changes onto task/<id>, merge (no-ff) into the main branch, then remove
// the worktree. Throws on merge conflict (caller reports; a human merges manually).
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
  await git(['merge', '--no-ff', branch, '-m', mergeMsg], repoRoot);
  const head = (await git(['rev-parse', 'HEAD'], repoRoot)).trim();
  await removeTaskWorktree(repoRoot, taskId).catch(() => {});
  return { merged: true, branch, commit: head };
}

export function sanitizeTaskId(taskId) {
  const clean = String(taskId ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '');
  if (!clean) throw new Error('Task id is required for a worktree.');
  return clean;
}
