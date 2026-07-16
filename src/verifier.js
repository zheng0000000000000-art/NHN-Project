import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { HttpError, normalizeRelativePath, nowIso, readJson, sha256 } from './utils.js';

const MAX_CAPTURE_BYTES = 256 * 1024;
const ACTIVE_WORKSPACES = new Set();

export class Verifier {
  constructor({ workspaceRoot, profilePath = null, harnessRegistry = null }) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.profilePath = profilePath;
    this.harnessRegistry = harnessRegistry;
  }

  async profileNames() {
    if (this.harnessRegistry) return this.harnessRegistry.activeIds();
    const config = await this.#config();
    return Object.keys(config.profiles);
  }

  async publicProfiles() {
    if (this.harnessRegistry) return this.harnessRegistry.publicProfiles();
    const config = await this.#config();
    return Object.fromEntries(Object.entries(config.profiles).map(([id, profile]) => [id, {
      id,
      label: profile.label ?? id,
      description: profile.description ?? '',
      commandCount: Array.isArray(profile.commands) ? profile.commands.length : 0,
    }]));
  }

  // `root` lets a task be verified inside its own git worktree (verify-in-worktree),
  // so an agent's isolated edits are actually checked. Defaults to the shared workspace.
  async run(task, { root } = {}) {
    const verifyRoot = root ? path.resolve(root) : this.workspaceRoot;
    return this.withWorkspaceLock(verifyRoot, () => this.runLocked(task, verifyRoot));
  }

  async withWorkspaceLock(rootOrWork, maybeWork) {
    const [root, work] = typeof rootOrWork === 'function' ? [this.workspaceRoot, rootOrWork] : [rootOrWork, maybeWork];
    const key = root ? path.resolve(root) : this.workspaceRoot;
    if (ACTIVE_WORKSPACES.has(key)) {
      throw new HttpError(409, 'Another verification is already running.');
    }
    ACTIVE_WORKSPACES.add(key);
    try {
      return await work();
    } finally {
      ACTIVE_WORKSPACES.delete(key);
    }
  }

  async runLocked(task, root = this.workspaceRoot) {
    const verifyRoot = path.resolve(root);
    const profile = this.harnessRegistry
      ? await this.harnessRegistry.resolveActive(task.verificationProfile)
      : (await this.#config()).profiles[task.verificationProfile];
    if (!profile) throw new HttpError(400, `Verification profile not found: ${task.verificationProfile}`);
    if (!await this.#isGitRepository(verifyRoot)) throw new HttpError(409, 'Verification root must be a Git repository for scope verification.');

    const startedAt = nowIso();
    const checks = [];
    for (const command of profile.commands ?? []) {
      const commandCwd = resolveCommandCwd(verifyRoot, command.cwd ?? '.');
      const sandboxed = sandboxWrap(command.file, command.args ?? [], verifyRoot, commandCwd);
      checks.push(await runProcess({
        file: sandboxed.file,
        args: sandboxed.args,
        cwd: sandboxed.cwd,
        expectedExit: Number.isInteger(command.expectedExit) ? command.expectedExit : 0,
        timeoutMs: Number.isFinite(command.timeoutMs) ? command.timeoutMs : 120_000,
      }));
    }

    const changedPaths = await this.changedPaths(verifyRoot);
    const scopeViolations = changedPaths.filter((changedPath) => !task.allowedPaths.some((pattern) => globMatch(pattern, changedPath)));
    const fingerprint = await this.workspaceFingerprint(changedPaths, verifyRoot);
    const commandPass = checks.every((check) => check.passed);
    const passed = commandPass && scopeViolations.length === 0;

    return {
      status: passed ? 'PASSED' : 'FAILED',
      profile: task.verificationProfile,
      startedAt,
      finishedAt: nowIso(),
      checks,
      changedPaths,
      scopeViolations,
      workspaceFingerprint: fingerprint,
      verifyRoot,
      passed,
    };
  }

  async changedPaths(root = this.workspaceRoot) {
    const tracked = await gitLines(root, ['diff', '--name-only', '--diff-filter=ACDMRTUXB', 'HEAD']);
    const staged = await gitLines(root, ['diff', '--cached', '--name-only', '--diff-filter=ACDMRTUXB', 'HEAD']);
    const untracked = await gitLines(root, ['ls-files', '--others', '--exclude-standard']);
    return [...new Set([...tracked, ...staged, ...untracked].map(normalizeRelativePath).filter(Boolean))].sort();
  }

  async workspaceFingerprint(paths = null, root = this.workspaceRoot) {
    const changedPaths = paths ?? await this.changedPaths(root);
    const head = (await gitCapture(root, ['rev-parse', 'HEAD'])).stdout.trim();
    const entries = [];
    for (const relativePath of changedPaths) {
      const fullPath = path.join(root, relativePath);
      try {
        const fileStat = await stat(fullPath);
        if (fileStat.isDirectory()) continue;
        entries.push({ path: relativePath, sha256: sha256(await readFile(fullPath)), size: fileStat.size });
      } catch (error) {
        if (error?.code === 'ENOENT') entries.push({ path: relativePath, deleted: true });
        else throw error;
      }
    }
    return sha256(JSON.stringify({ head, entries }));
  }

  async fingerprintMatches(verification, root = null) {
    if (!verification?.workspaceFingerprint) return false;
    const verifyRoot = root ? path.resolve(root) : (verification.verifyRoot ? path.resolve(verification.verifyRoot) : this.workspaceRoot);
    return verification.workspaceFingerprint === await this.workspaceFingerprint(null, verifyRoot);
  }

  async #config() {
    const config = await readJson(this.profilePath, { schemaVersion: 1, profiles: {} });
    if (!config.profiles || typeof config.profiles !== 'object') throw new Error('Invalid verification profile configuration.');
    return config;
  }

  async #isGitRepository(root = this.workspaceRoot) {
    const result = await gitCapture(root, ['rev-parse', '--is-inside-work-tree'], 15_000, false);
    return result.actualExit === 0 && result.stdout.trim() === 'true';
  }
}


export function sandboxWrap(file, args, root, cwd) {
  const mode = process.env.TEAM_LOOP_SANDBOX;
  if (!mode || mode === 'off') return { file, args, cwd };
  const skip = (process.env.TEAM_LOOP_SANDBOX_SKIP || 'git').split(',').map((s) => s.trim()).filter(Boolean);
  if (skip.includes(file)) return { file, args, cwd };
  const relative = path.relative(root, cwd).split(path.sep).join('/');
  const workdir = relative ? `/work/${relative}` : '/work';
  if (mode === 'docker') {
    const image = process.env.TEAM_LOOP_SANDBOX_IMAGE || 'node:20-bookworm';
    const extra = (process.env.TEAM_LOOP_SANDBOX_DOCKER_ARGS || '').split(' ').map((part) => part.trim()).filter(Boolean);
    const dockerArgs = [
      'run', '--rm', '--network', 'none',
      '--memory', process.env.TEAM_LOOP_SANDBOX_MEMORY || '512m',
      '--pids-limit', process.env.TEAM_LOOP_SANDBOX_PIDS || '256',
      '-v', `${root}:/work`, '-w', workdir,
      ...extra, image, file, ...args,
    ];
    return { file: process.env.TEAM_LOOP_DOCKER_BIN || 'docker', args: dockerArgs, cwd: root };
  }
  const prefix = (process.env.TEAM_LOOP_SANDBOX_ARGS || '').split(' ').map((part) => part.trim()).filter(Boolean)
    .map((part) => part.replace('{root}', root).replace('{cwd}', cwd));
  return { file: mode, args: [...prefix, file, ...args], cwd };
}

function resolveCommandCwd(root, relative) {
  const value = String(relative ?? '.');
  if (path.isAbsolute(value)) throw new HttpError(400, 'Harness command cwd must be relative to the workspace.');
  const resolved = path.resolve(root, value);
  const prefix = `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(prefix)) throw new HttpError(400, 'Harness command cwd escapes the workspace.');
  return resolved;
}

async function gitLines(cwd, args) {
  const result = await gitCapture(cwd, args);
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function gitCapture(cwd, args, timeoutMs = 30_000, throwOnFailure = true) {
  const result = await runProcess({ file: 'git', args, cwd, expectedExit: 0, timeoutMs });
  if (throwOnFailure && !result.passed) throw new HttpError(409, `Git command failed: git ${args.join(' ')}`, result);
  return result;
}

export async function runProcess({ file, args, cwd, expectedExit, timeoutMs }) {
  return new Promise((resolve) => {
    const startedAt = nowIso();
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    const child = spawn(file, args, { cwd, shell: false, windowsHide: true });

    const append = (current, chunk) => {
      const next = Buffer.concat([current, chunk]);
      return next.length > MAX_CAPTURE_BYTES ? next.subarray(next.length - MAX_CAPTURE_BYTES) : next;
    };

    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk); });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1500).unref();
    }, timeoutMs);

    const finish = (exitCode, spawnError = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const actualExit = Number.isInteger(exitCode) ? exitCode : 2;
      resolve({
        file,
        args,
        expectedExit,
        actualExit,
        passed: !spawnError && !timedOut && actualExit === expectedExit,
        timedOut,
        spawnError: Boolean(spawnError),
        spawnErrorCode: spawnError?.code ?? null,
        startedAt,
        finishedAt: nowIso(),
        stdout: stdout.toString('utf8'),
        stderr: `${stderr.toString('utf8')}${spawnError ? `\n${spawnError.message}` : ''}`.trim(),
      });
    };

    child.on('error', (error) => finish(2, error));
    child.on('close', (code) => finish(code));
  });
}

export function globMatch(pattern, relativePath) {
  const normalizedPattern = normalizeRelativePath(pattern);
  const normalizedPath = normalizeRelativePath(relativePath);
  if (normalizedPattern === '**' || normalizedPattern === '*') return true;
  let regex = '^';
  for (let i = 0; i < normalizedPattern.length; i += 1) {
    const char = normalizedPattern[i];
    const next = normalizedPattern[i + 1];
    if (char === '*' && next === '*') {
      const after = normalizedPattern[i + 2];
      if (after === '/') {
        regex += '(?:.*/)?';
        i += 2;
      } else {
        regex += '.*';
        i += 1;
      }
    } else if (char === '*') regex += '[^/]*';
    else if (char === '?') regex += '[^/]';
    else regex += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  regex += '$';
  return new RegExp(regex).test(normalizedPath);
}
