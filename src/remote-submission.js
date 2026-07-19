import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createTaskWorktree, worktreeHasChanges, worktreePath } from './worktree.js';
import { globMatch } from './verifier.js';
import { HttpError, normalizeRelativePath } from './utils.js';

const MAX_FILES = 50;
const MAX_TOTAL_BYTES = 512 * 1024;
const MAX_FILE_BYTES = 256 * 1024;

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0
      ? resolve(stdout.trim())
      : reject(new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`)));
  });
}

function safeTaskPath(task, candidate) {
  const raw = String(candidate ?? '').replaceAll('\\', '/');
  const relative = normalizeRelativePath(candidate);
  if (!relative || relative === '.' || path.isAbsolute(String(candidate)) || raw.split('/').includes('..')) {
    throw new HttpError(400, `Unsafe submission path: ${candidate}`);
  }
  if (!(task.allowedPaths || []).some((pattern) => globMatch(pattern, relative))) {
    throw new HttpError(403, `Path is outside task scope: ${relative}`);
  }
  return relative;
}

function normalizeFiles(task, files) {
  if (!Array.isArray(files) || files.length === 0) throw new HttpError(400, 'At least one submitted file is required.');
  if (files.length > MAX_FILES) throw new HttpError(413, `A submission may contain at most ${MAX_FILES} files.`);
  const seen = new Set();
  let totalBytes = 0;
  return files.map((file) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw new HttpError(400, 'Each submitted file must be an object.');
    const relative = safeTaskPath(task, file.path);
    if (seen.has(relative)) throw new HttpError(400, `Duplicate submission path: ${relative}`);
    seen.add(relative);
    const deleted = file.deleted === true;
    const content = deleted ? '' : String(file.content ?? '');
    if (content.includes('\0')) throw new HttpError(400, `Binary content is not supported: ${relative}`);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_FILE_BYTES) throw new HttpError(413, `Submitted file is too large: ${relative}`);
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BYTES) throw new HttpError(413, 'Submission content is too large.');
    return { path: relative, content, deleted };
  });
}

export async function projectHead(workspaceRoot) {
  return git(['rev-parse', 'HEAD'], workspaceRoot);
}

export async function readRemoteTaskFiles(workspaceRoot, task, paths) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_FILES) {
    throw new HttpError(400, `Request between 1 and ${MAX_FILES} task files.`);
  }
  const baseCommit = await projectHead(workspaceRoot);
  const taskWorktree = worktreePath(workspaceRoot, task.id);
  const sourceRoot = task.delivery?.type === 'MCP_FILES' && existsSync(taskWorktree) ? taskWorktree : workspaceRoot;
  const files = [];
  for (const candidate of paths) {
    const relative = safeTaskPath(task, candidate);
    const target = path.resolve(sourceRoot, relative);
    if (!target.startsWith(`${path.resolve(sourceRoot)}${path.sep}`)) throw new HttpError(400, `Unsafe task path: ${relative}`);
    try {
      const content = await readFile(target, 'utf8');
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES || content.includes('\0')) {
        throw new HttpError(413, `Task file is not a supported text file: ${relative}`);
      }
      files.push({ path: relative, content });
    } catch (error) {
      if (error?.code === 'ENOENT') files.push({ path: relative, missing: true });
      else throw error;
    }
  }
  return { baseCommit, files };
}

export async function applyRemoteTaskSubmission(workspaceRoot, task, input) {
  if (task.status !== 'IN_PROGRESS') throw new HttpError(409, 'Remote submission requires an IN_PROGRESS task.');
  const baseCommit = String(input.baseCommit || '').trim();
  const currentHead = await projectHead(workspaceRoot);
  if (!/^[0-9a-f]{40}$/i.test(baseCommit)) throw new HttpError(400, 'A full 40-character baseCommit is required.');
  if (baseCommit !== currentHead) throw new HttpError(409, 'Project changed after the files were read. Refresh task files before submitting.');
  const files = normalizeFiles(task, input.files);
  const existing = worktreePath(workspaceRoot, task.id);
  if (existsSync(existing) && await worktreeHasChanges(workspaceRoot, task.id)) {
    if (task.delivery?.type !== 'MCP_FILES') throw new HttpError(409, 'The server worktree already contains non-MCP changes.');
  }
  const prepared = existsSync(existing) && task.delivery?.type === 'MCP_FILES'
    ? { dir: existing, branch: task.delivery.branch }
    : await createTaskWorktree(workspaceRoot, task.id, { base: baseCommit });
  const { dir, branch } = prepared;
  for (const file of files) {
    const target = path.resolve(dir, file.path);
    if (!target.startsWith(`${path.resolve(dir)}${path.sep}`)) throw new HttpError(400, `Unsafe submission path: ${file.path}`);
    if (file.deleted) await rm(target, { force: true });
    else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content, 'utf8');
    }
  }
  return {
    baseCommit,
    branch,
    files: files.map(({ path: filePath, deleted }) => ({ path: filePath, deleted })),
    summary: String(input.summary || '').trim().slice(0, 2000),
    learningDisposition: String(input.learningDisposition || '').trim().slice(0, 2000),
  };
}
