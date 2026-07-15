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

  async run(task) {
    return this.withWorkspaceLock(() => this.runLocked(task));
  }

  async withWorkspaceLock(work) {
    if (ACTIVE_WORKSPACES.has(this.workspaceRoot)) {
      throw new HttpError(409, 'Another verification is already running.');
    }
    ACTIVE_WORKSPACES.add(this.workspaceRoot);
    try {
      return await work();
    } finally {
      ACTIVE_WORKSPACES.delete(this.workspaceRoot);
    }
  }

  async runLocked(task) {
    const profile = this.harnessRegistry
      ? await this.harnessRegistry.resolveActive(task.verificationProfile)
      : (await this.#config()).profiles[task.verificationProfile];
    if (!profile) throw new HttpError(400, `Verification profile not found: ${task.verificationProfile}`);
    if (!await this.#isGitRepository()) throw new HttpError(409, 'WORKSPACE_ROOT must be a Git repository for scope verification.');

    const startedAt = nowIso();
    const checks = [];
    for (const command of profile.commands ?? []) {
      checks.push(await runProcess({
        file: command.file,
        args: command.args ?? [],
        cwd: resolveCommandCwd(this.workspaceRoot, command.cwd ?? '.'),
        expectedExit: Number.isInteger(command.expectedExit) ? command.expectedExit : 0,
        timeoutMs: Number.isFinite(command.timeoutMs) ? command.timeoutMs : 120_000,
      }));
    }

    const changedPaths = await this.changedPaths();
    const scopeViolations = changedPaths.filter((changedPath) => !task.allowedPaths.some((pattern) => globMatch(pattern, changedPath)));
    const fingerprint = await this.workspaceFingerprint(changedPaths);
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
      passed,
    };
  }

  async changedPaths() {
    const tracked = await gitLines(this.workspaceRoot, ['diff', '--name-only', '--diff-filter=ACDMRTUXB', 'HEAD']);
    const staged = await gitLines(this.workspaceRoot, ['diff', '--cached', '--name-only', '--diff-filter=ACDMRTUXB', 'HEAD']);
    const untracked = await gitLines(this.workspaceRoot, ['ls-files', '--others', '--exclude-standard']);
    return [...new Set([...tracked, ...staged, ...untracked].map(normalizeRelativePath).filter(Boolean))].sort();
  }

  async workspaceFingerprint(paths = null) {
    const changedPaths = paths ?? await this.changedPaths();
    const head = (await gitCapture(this.workspaceRoot, ['rev-parse', 'HEAD'])).stdout.trim();
    const entries = [];
    for (const relativePath of changedPaths) {
      const fullPath = path.join(this.workspaceRoot, relativePath);
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

  async fingerprintMatches(verification) {
    if (!verification?.workspaceFingerprint) return false;
    return verification.workspaceFingerprint === await this.workspaceFingerprint();
  }

  async #config() {
    const config = await readJson(this.profilePath, { schemaVersion: 1, profiles: {} });
    if (!config.profiles || typeof config.profiles !== 'object') throw new Error('Invalid verification profile configuration.');
    return config;
  }

  async #isGitRepository() {
    const result = await gitCapture(this.workspaceRoot, ['rev-parse', '--is-inside-work-tree'], 15_000, false);
    return result.actualExit === 0 && result.stdout.trim() === 'true';
  }
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
