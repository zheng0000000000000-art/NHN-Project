import path from 'node:path';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { HttpError, nowIso, sha256 } from './utils.js';
import { buildSkillPolicy } from './skill-policy.js';
import { ScopeLeaseService } from './scope-leases.js';
import { normalizeSharedContracts, resolveRunMode } from './run-mode.js';
import { RunLedger } from './run-ledger.js';

const RUN_ID = /^[a-z0-9][a-z0-9._-]{2,79}$/;

export class RunArtifactService {
  constructor({ workspaceRoot, verifier }) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.verifier = verifier;
    this.scopeLeases = new ScopeLeaseService({ workspaceRoot: this.workspaceRoot });
    this.ledger = new RunLedger({ workspaceRoot: this.workspaceRoot });
  }

  async verifyFile(filePath, { force = false, root = null, releaseOnPass = true, passedScopeState = 'VERIFIED_AWAITING_APPROVAL' } = {}) {
    const absoluteRunPath = withinWorkspace(this.workspaceRoot, filePath);
    const document = normalizeRunDocument(JSON.parse(await readFile(absoluteRunPath, 'utf8')));
    const relativeRunPath = slash(path.relative(this.workspaceRoot, absoluteRunPath));

    const declaredPaths = document.changes.map((item) => item.path);
    const skillPolicy = await buildSkillPolicy({ workspaceRoot: this.workspaceRoot, document });
    const scopeLease = await this.scopeLeases.find(document.id);
    const revisionStatus = scopeLease ? await this.scopeLeases.revisionStatus(scopeLease) : null;
    const externalProject = await fileExists(path.join(this.workspaceRoot, '.team-loop', 'project.json'));
    const supportsRuntimeE2E = await fileExists(path.join(this.workspaceRoot, 'tools', 'verification', 'check-runtime.mjs'));
    const selection = selectVerificationProfile(document.verification.profile, document.writeScope, document.mode.appliedMode, { preferRequestedProfile: externalProject, supportsRuntimeE2E });
    const allowedPaths = [...new Set([...document.writeScope, relativeRunPath, '.team-loop/results/**', '.team-loop/failures/**', '.team-loop/learning/**', '.team-loop/scopes/**', '.team-loop/scope-lock/**', '.team-loop-worktrees/**'])];
    const verification = await this.verifier.run({ verificationProfile: selection.appliedProfile, allowedPaths }, root ? { root } : undefined);
    const actualProductPaths = verification.changedPaths.filter((item) => !item.startsWith('.team-loop/') && !item.startsWith('.team-loop-worktrees/'));
    const undeclaredPaths = actualProductPaths.filter((item) => !declaredPaths.includes(item));
    const missingDeclaredPaths = declaredPaths.filter((item) => !actualProductPaths.includes(item));
    const documentMatch = undeclaredPaths.length === 0 && missingDeclaredPaths.length === 0;
    const baseRevisionSafe = !root || !revisionStatus?.touchesWriteScope;
    const verdict = verification.passed && documentMatch && baseRevisionSafe ? 'PASSED' : 'FAILED';
    const result = {
      schemaVersion: 1,
      runId: document.id,
      taskId: document.taskId || null,
      verifiedAt: nowIso(),
      verdict,
      documentSha256: sha256(JSON.stringify(document)),
      documentPath: relativeRunPath,
      declaredPaths,
      actualPaths: actualProductPaths,
      undeclaredPaths,
      missingDeclaredPaths,
      documentMatch,
      mode: document.mode,
      baseRevisionSafe,
      skillPolicy,
      scopeLease: scopeLease ? { ...scopeLease, revisionStatus, state: 'ACTIVE_DURING_VERIFICATION' } : { state: 'NOT_ACQUIRED' },
      verificationPolicy: selection,
      verification,
    };
    if (verdict === 'FAILED') await this.#recordFailures(document, result);
    if (verdict === 'PASSED' && scopeLease && releaseOnPass) {
      result.scopeLease.state = 'RELEASED_AFTER_PASS';
      await this.scopeLeases.release(document.id, { reason: 'verification passed', owner: scopeLease.owner });
    }
    if (verdict === 'PASSED' && scopeLease && !releaseOnPass) result.scopeLease.state = passedScopeState;
    const stored = await this.ledger.append(document.id, result);
    await this.#recordSkillOutcome(stored.result);
    return { document, result: stored.result, resultPath: stored.resultPath };
  }

  async #recordSkillOutcome(result) {
    const file = path.join(this.workspaceRoot, '.team-loop', 'learning', 'skill-outcomes.jsonl');
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify({ at: result.verifiedAt, runId: result.runId, attempt: result.attempt, verdict: result.verdict, skillIds: result.skillPolicy.selected.map((item) => item.id) })}\n`, 'utf8');
  }

  async #recordFailures(document, result) {
    const events = [];
    for (const check of result.verification.checks || []) {
      if (check.passed) continue;
      events.push({
        kind: 'EXIT_MISMATCH', runId: document.id, profile: result.verificationPolicy.appliedProfile,
        file: check.file, args: check.args, expectedExit: check.expectedExit, actualExit: check.actualExit,
        signature: sha256(JSON.stringify({ kind: 'EXIT_MISMATCH', profile: result.verificationPolicy.appliedProfile, file: check.file, args: check.args, expectedExit: check.expectedExit })),
      });
    }
    if (result.undeclaredPaths.length || result.verification.scopeViolations?.length) {
      const paths = [...new Set([...result.undeclaredPaths, ...(result.verification.scopeViolations || [])])].sort();
      events.push({ kind: 'SCOPE_VIOLATION', runId: document.id, profile: result.verificationPolicy.appliedProfile, paths, signature: sha256(JSON.stringify({ kind: 'SCOPE_VIOLATION', paths })) });
    }
    if (result.missingDeclaredPaths.length) {
      events.push({ kind: 'DOCUMENT_MISMATCH', runId: document.id, paths: result.missingDeclaredPaths, signature: sha256(JSON.stringify({ kind: 'DOCUMENT_MISMATCH', paths: result.missingDeclaredPaths })) });
    }
    if (result.baseRevisionSafe === false) {
      events.push({ kind: 'BASE_REVISION_DRIFT', runId: document.id, paths: result.scopeLease.revisionStatus?.changedPaths || [], signature: sha256(JSON.stringify({ kind: 'BASE_REVISION_DRIFT', paths: result.scopeLease.revisionStatus?.changedPaths || [] })) });
    }
    if (!events.length) return;
    const failurePath = path.join(this.workspaceRoot, '.team-loop', 'failures', 'events.jsonl');
    await mkdir(path.dirname(failurePath), { recursive: true });
    await appendFile(failurePath, events.map((event) => JSON.stringify({ at: nowIso(), ...event })).join('\n') + '\n', 'utf8');
  }
}

export function selectVerificationProfile(requestedProfile, changedPaths, mode = 'CODE', { preferRequestedProfile = false, supportsRuntimeE2E = true } = {}) {
  const paths = Array.isArray(changedPaths) ? changedPaths : [];
  const runtimeCritical = paths.some((value) => value === 'server.js' || value === 'public/app.js' || value.startsWith('src/cli/') || value === 'src/run-artifacts.js' || value.startsWith('tools/verification/'));
  const nodeCode = paths.some((value) => /(?:^|\/)(?:[^/]+\.)?(?:js|mjs|cjs)$/.test(value) || value.startsWith('src/') || value.startsWith('test/'));
  const modeProfile = mode === 'BRAINSTORM' ? 'brainstorm-review' : mode === 'DOCUMENT' ? 'document-review' : requestedProfile;
  const appliedProfile = runtimeCritical && supportsRuntimeE2E ? 'verified-run' : nodeCode && !preferRequestedProfile ? 'node-project' : modeProfile;
  const strength = appliedProfile === 'verified-run' ? 'E2E' : ['node-project', 'document-review', 'brainstorm-review'].includes(appliedProfile) ? 'TESTED' : 'BASIC';
  return {
    requestedProfile,
    appliedProfile,
    strength,
    autoEscalated: appliedProfile !== requestedProfile,
    reason: runtimeCritical && supportsRuntimeE2E ? 'runtime-critical server, frontend, CLI, or verification engine path changed' : nodeCode && !preferRequestedProfile ? 'Node source or test path changed' : modeProfile !== requestedProfile ? `${mode} mode verification applied` : 'declared project profile accepted',
  };
}

export function normalizeRunDocument(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Run document must be a JSON object.');
  const id = String(input.id || '').trim();
  if (!RUN_ID.test(id)) throw new HttpError(400, 'Run id must be 3-80 lowercase letters, numbers, dots, dashes, or underscores.');
  const title = String(input.title || '').trim();
  if (title.length < 3 || title.length > 160) throw new HttpError(400, 'Run title must be 3-160 characters.');
  const changes = (Array.isArray(input.changes) ? input.changes : []).map((item) => ({
    path: safeRelativePath(item?.path), summary: String(item?.summary || '').trim().slice(0, 500),
  }));
  const writeScope = normalizeScope(input.writeScope, changes.map((item) => item.path));
  if (!changes.length && !writeScope.length) throw new HttpError(400, 'Run document must declare changes or a write scope.');
  if (new Set(changes.map((item) => item.path)).size !== changes.length) throw new HttpError(400, 'Run document contains duplicate changed paths.');
  const profile = String(input.verification?.profile || '').trim();
  if (!profile) throw new HttpError(400, 'verification.profile is required.');
  const objective = String(input.objective || '').trim().slice(0, 1000);
  const mode = resolveRunMode({ ...input, objective }, writeScope);
  return {
    schemaVersion: 1, id, title,
    taskId: String(input.taskId || '').trim().slice(0, 100) || null,
    summary: String(input.summary || '').trim().slice(0, 2000),
    objective,
    audience: String(input.audience || '').trim().slice(0, 300),
    mode,
    sharedContracts: normalizeSharedContracts(input.sharedContracts),
    agent: String(input.agent || '').trim().slice(0, 100),
    createdAt: String(input.createdAt || nowIso()),
    changes,
    verification: { profile },
    appliedSkills: [...new Set((Array.isArray(input.appliedSkills) ? input.appliedSkills : []).map(String).map((item) => item.trim()).filter(Boolean))].slice(0, 20),
    writeScope,
    readScope: normalizeScope(input.readScope, []),
    interfaces: [...new Set((Array.isArray(input.interfaces) ? input.interfaces : []).map((item) => String(item).trim()).filter(Boolean))].slice(0, 50),
  };
}

function normalizeScope(value, fallback) {
  if (value == null) return fallback;
  if (!Array.isArray(value)) throw new HttpError(400, 'Scope must be an array.');
  return [...new Set(value.map(safeRelativePath))].slice(0, 100);
}

function safeRelativePath(value) {
  const normalized = slash(String(value || '').trim()).replace(/^\.\//, '');
  if (!normalized || path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) throw new HttpError(400, `Unsafe changed path: ${value}`);
  if (normalized.startsWith('.team-loop/')) throw new HttpError(400, 'Product changes may not target .team-loop metadata.');
  return normalized;
}

function withinWorkspace(root, value) {
  const absolute = path.resolve(root, String(value || ''));
  const relative = path.relative(root, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new HttpError(400, 'Run document escapes the workspace.');
  return absolute;
}
function slash(value) { return String(value).replaceAll('\\', '/'); }
async function fileExists(file) { try { await readFile(file); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } }
