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

function sanitizeTaskId(taskId) {
  const clean = String(taskId ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '');
  if (!clean) throw new Error('Task id is required for a worktree.');
  return clean;
}
