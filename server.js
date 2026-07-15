import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { clearSessionCookie, issueSession, loadOrCreateSecret, parseCookies, readSession, sessionCookie } from './src/auth.js';
import { Store } from './src/store.js';
import { Verifier } from './src/verifier.js';
import { AIService } from './src/ai.js';
import { UsageTracker } from './src/usage.js';
import { ExternalUsageStore } from './src/external-usage.js';
import { HarnessRegistry } from './src/harness-registry.js';
import { FailureCaseStore } from './src/failure-cases.js';
import { SkillRegistry } from './src/skill-registry.js';
import { FailureLearningService } from './src/failure-learning.js';
import { sanitizeExecutorInput } from './src/executor.js';
import { scopesOverlap } from './src/scope.js';
import { ProjectContextStore } from './src/project-context.js';
import { FixedWindowRateLimiter } from './src/rate-limit.js';
import { assertPlainObject, HttpError, nowIso, sha256 } from './src/utils.js';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(projectRoot, 'public');
const dataDirectory = path.resolve(process.env.DATA_DIR || path.join(projectRoot, 'data'));
const workspaceRoot = path.resolve(process.env.WORKSPACE_ROOT || projectRoot);
const profilePath = path.resolve(process.env.VERIFICATION_PROFILES || path.join(projectRoot, 'config', 'verification-profiles.json'));
const usageConfigPath = path.resolve(process.env.USAGE_CONFIG || path.join(projectRoot, 'config', 'usage-dashboard.json'));
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 4173);
const secureCookies = process.env.SECURE_COOKIES === 'true';
const signupCode = process.env.SIGNUP_CODE || '';
const soloMode = process.env.SOLO_MODE === 'true';
const serverStartedAt = Date.now();
const authRateLimiter = new FixedWindowRateLimiter({ limit: 10, windowMs: 60_000 });
const externalUsageRateLimiter = new FixedWindowRateLimiter({ limit: 4, windowMs: 60_000 });

const store = new Store(dataDirectory, { signupCode, serverStartedAt });
const harnessRegistry = new HarnessRegistry({ dataDirectory, seedProfilePath: profilePath, workspaceRoot });
const verifier = new Verifier({ workspaceRoot, harnessRegistry });
const failureCases = new FailureCaseStore(dataDirectory);
const skillRegistry = new SkillRegistry({ dataDirectory });
const learning = new FailureLearningService({ failureCases, harnessRegistry, skillRegistry });
const projectContext = new ProjectContextStore(dataDirectory);
const ai = new AIService();
const usageTracker = new UsageTracker({ dataDirectory, configPath: usageConfigPath });
const externalUsage = new ExternalUsageStore({ dataDirectory });
await Promise.all([store.initialize(), harnessRegistry.initialize(), failureCases.initialize(), skillRegistry.initialize(), projectContext.initialize(), usageTracker.initialize(), externalUsage.initialize()]);
const sessionSecret = await loadOrCreateSecret(dataDirectory);

const server = http.createServer(async (request, response) => {
  try {
    if (request.url?.startsWith('/api/')) {
      await handleApi(request, response);
      return;
    }
    await serveStatic(request, response);
  } catch (error) {
    sendError(response, error);
  }
});

server.listen(port, host, () => {
  const address = server.address();
  const listeningPort = typeof address === 'object' && address ? address.port : port;
  console.log(`Team Loop Lite listening on http://${host}:${listeningPort}`);
  console.log(`Workspace: ${workspaceRoot}`);
  if (!signupCode) {
    console.warn('WARNING: SIGNUP_CODE is not configured. The first administrator may register only during the first 10 minutes after startup.');
  }
});

async function handleApi(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const method = request.method || 'GET';

  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) requireTrustedClientHeader(request);

  if (method === 'POST' && url.pathname === '/api/auth/register') {
    const body = await readBody(request);
    assertPlainObject(body);
    authRateLimiter.consume(authRateKey(request, 'register', body.name));
    const user = await store.registerUser(body);
    response.setHeader('Set-Cookie', sessionCookie(issueSession(sessionSecret, user.id), secureCookies));
    sendJson(response, 201, { user });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readBody(request);
    assertPlainObject(body);
    authRateLimiter.consume(authRateKey(request, 'login', body.name));
    const user = await store.authenticate(body.name, body.password);
    response.setHeader('Set-Cookie', sessionCookie(issueSession(sessionSecret, user.id), secureCookies));
    sendJson(response, 200, { user });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/auth/logout') {
    response.setHeader('Set-Cookie', clearSessionCookie(secureCookies));
    sendJson(response, 200, { ok: true });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, { ok: true, at: nowIso() });
    return;
  }

  const actor = await requireUser(request);

  if (method === 'GET' && url.pathname === '/api/bootstrap') {
    const [users, tasks, profiles, harnesses, skills, failures, failureSummary, context] = await Promise.all([
      store.listUsers(),
      store.listTasks(),
      verifier.publicProfiles(),
      harnessRegistry.list(),
      skillRegistry.list(),
      failureCases.list({ limit: 100 }),
      failureCases.summary(),
      projectContext.get(),
    ]);
    sendJson(response, 200, {
      user: actor,
      users,
      tasks,
      profiles,
      ai: ai.status(),
      usage: usageTracker.status(),
      harnesses,
      skills,
      failures,
      failureSummary,
      projectContext: context,
      workspace: { root: workspaceRoot },
    });
    return;
  }

  if (method === 'PUT' && url.pathname === '/api/project-context') {
    const body = await readBody(request);
    assertPlainObject(body);
    const context = await projectContext.update(actor, body);
    await store.recordAudit(actor.id, 'PROJECT_CONTEXT_UPDATED', {
      length: context.content.length,
      contentSha256: context.content ? sha256(context.content) : null,
    });
    sendJson(response, 200, { projectContext: context });
    return;
  }


  if (method === 'GET' && url.pathname === '/api/usage') {
    const days = Number(url.searchParams.get('days') || 30);
    const allUsers = await store.listUsers();
    const visibleUsers = actor.role === 'admin' ? allUsers : allUsers.filter((user) => user.id === actor.id);
    const actorUserIds = visibleUsers.map((user) => user.id);
    const [usage, external] = await Promise.all([
      usageTracker.summary({ days, users: visibleUsers, actorUserIds }),
      externalUsage.summary({ days, users: visibleUsers, actorUserIds }),
    ]);
    usage.external = external;
    usage.scope.visibility = actor.role === 'admin' ? 'TEAM' : 'SELF';
    usage.scope.description = actor.role === 'admin'
      ? 'Team Loop 서버 경유 AI 요청과 외부 Claude Code/Codex 참고 집계를 분리해 표시합니다. 외부 사용량은 예산에 합산하지 않습니다.'
      : '현재 로그인한 사용자 본인의 서버 AI 요청과 외부 Claude Code/Codex 참고 집계만 표시합니다.';
    sendJson(response, 200, { usage });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/usage/external') {
    externalUsageRateLimiter.consume(`external-usage:${actor.id}`, 'Too many external usage snapshots. Try again later.');
    const body = await readBody(request);
    assertPlainObject(body);
    const result = await externalUsage.record(actor.id, body);
    await store.recordAudit(actor.id, result.duplicate ? 'EXTERNAL_USAGE_DUPLICATE' : 'EXTERNAL_USAGE_RECORDED', {
      tool: result.snapshot.tool,
      machineId: result.snapshot.machineId,
      windowId: result.snapshot.tokens?.windowId || null,
      duplicate: result.duplicate,
      quotaWindows: result.snapshot.quota?.windows.length || 0,
    });
    sendJson(response, result.duplicate ? 200 : 201, {
      accepted: result.accepted,
      duplicate: result.duplicate,
      windowId: result.snapshot.tokens?.windowId || null,
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/users') {
    sendJson(response, 200, { users: await store.listUsers() });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/tasks') {
    sendJson(response, 200, { tasks: await store.listTasks() });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/harnesses') {
    sendJson(response, 200, { harnesses: await harnessRegistry.list() });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/harnesses') {
    requireAdmin(actor);
    const body = await readBody(request);
    assertPlainObject(body);
    const harness = await harnessRegistry.create(actor, body);
    await store.recordAudit(actor.id, 'HARNESS_CREATED', { harnessId: harness.id, version: harness.version, definitionSha256: harness.definitionSha256 });
    sendJson(response, 201, { harness });
    return;
  }

  const harnessMatch = url.pathname.match(/^\/api\/harnesses\/([^/]+)(?:\/(update|test|activate|disable))?$/);
  if (harnessMatch) {
    const [, harnessId, harnessAction] = harnessMatch;
    if (method === 'GET' && !harnessAction) {
      const harness = await harnessRegistry.get(harnessId);
      if (!harness) throw new HttpError(404, 'Harness not found.');
      sendJson(response, 200, { harness });
      return;
    }
    if (method === 'POST' && harnessAction) {
      requireAdmin(actor);
      const body = await readBody(request);
      assertPlainObject(body);
      if (harnessAction === 'update') {
        const harness = await harnessRegistry.update(harnessId, actor, body.expectedVersion, body);
        await store.recordAudit(actor.id, 'HARNESS_UPDATED', { harnessId, version: harness.version, definitionSha256: harness.definitionSha256 });
        sendJson(response, 200, { harness });
        return;
      }
      if (harnessAction === 'test') {
        const result = await harnessRegistry.test(harnessId, actor.id);
        const recorded = result.test.passed ? [] : await failureCases.recordHarnessTest({ harness: result.harness, test: result.test, actorUserId: actor.id });
        await store.recordAudit(actor.id, 'HARNESS_TESTED', { harnessId, passed: result.test.passed, failureCaseIds: recorded.map((item) => item.id) });
        sendJson(response, 200, { ...result, failureCases: recorded });
        return;
      }
      const status = harnessAction === 'activate' ? 'ACTIVE' : 'DISABLED';
      const harness = await harnessRegistry.setStatus(harnessId, actor.id, body.expectedVersion, status);
      await store.recordAudit(actor.id, status === 'ACTIVE' ? 'HARNESS_ACTIVATED' : 'HARNESS_DISABLED', { harnessId, version: harness.version });
      sendJson(response, 200, { harness });
      return;
    }
  }

  if (method === 'GET' && url.pathname === '/api/skills') {
    sendJson(response, 200, { skills: await skillRegistry.list() });
    return;
  }

  const skillMatch = url.pathname.match(/^\/api\/skills\/([^/]+)(?:\/(activate|disable))?$/);
  if (skillMatch) {
    const [, skillId, skillAction] = skillMatch;
    if (method === 'GET' && !skillAction) {
      const skill = await skillRegistry.get(skillId);
      if (!skill) throw new HttpError(404, 'Skill not found.');
      sendJson(response, 200, { skill });
      return;
    }
    if (method === 'POST' && skillAction) {
      requireAdmin(actor);
      const body = await readBody(request);
      assertPlainObject(body);
      const status = skillAction === 'activate' ? 'ACTIVE' : 'DISABLED';
      const skill = await skillRegistry.setStatus(skillId, actor.id, body.expectedVersion, status);
      await store.recordAudit(actor.id, status === 'ACTIVE' ? 'SKILL_ACTIVATED' : 'SKILL_DISABLED', { skillId, version: skill.version });
      sendJson(response, 200, { skill });
      return;
    }
  }

  if (method === 'POST' && url.pathname === '/api/learning/craft') {
    requireAdmin(actor);
    const body = await readBody(request);
    assertPlainObject(body);
    const result = await learning.craft(actor, body);
    await store.recordAudit(actor.id, 'FAILURE_LEARNING_CRAFTED', {
      type: result.type,
      harnessId: result.harness?.id ?? null,
      skillId: result.skill?.id ?? null,
      sourceFailureCaseIds: result.sourceFailureCases.map((item) => item.id),
    });
    sendJson(response, 201, result);
    return;
  }

  const applyLearningMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/apply-learning$/);
  if (method === 'POST' && applyLearningMatch) {
    const current = await store.getTask(applyLearningMatch[1]);
    if (!current) throw new HttpError(404, 'Task not found.');
    requireTaskParticipantOrAdmin(current, actor);
    const body = await readBody(request);
    assertPlainObject(body);
    const result = await learning.applyToTask({
      actor,
      store,
      taskId: applyLearningMatch[1],
      expectedVersion: body.expectedVersion,
      harnessId: body.harnessId,
      skillIds: body.skillIds,
    });
    await store.recordAudit(actor.id, 'TASK_LEARNING_APPLIED', {
      taskId: result.task.id,
      harnessId: result.harness?.id ?? null,
      skillIds: result.skills.map((item) => item.id),
    });
    sendJson(response, 200, result);
    return;
  }

  if (method === 'GET' && url.pathname === '/api/failures') {
    sendJson(response, 200, {
      failures: await failureCases.list({
        status: url.searchParams.get('status') || undefined,
        harnessId: url.searchParams.get('harnessId') || undefined,
        limit: Number(url.searchParams.get('limit') || 200),
      }),
      summary: await failureCases.summary(),
    });
    return;
  }

  const failureMatch = url.pathname.match(/^\/api\/failures\/([^/]+)(?:\/(status|promote))?$/);
  if (failureMatch) {
    const [, failureId, failureAction] = failureMatch;
    if (method === 'GET' && !failureAction) {
      const failure = await failureCases.get(failureId);
      if (!failure) throw new HttpError(404, 'Failure case not found.');
      sendJson(response, 200, { failure });
      return;
    }
    if (method === 'POST' && failureAction === 'status') {
      const body = await readBody(request);
      assertPlainObject(body);
      const failure = await failureCases.setStatus(failureId, actor.id, String(body.status || '').toUpperCase(), body.note);
      await store.recordAudit(actor.id, 'FAILURE_STATUS_CHANGED', { failureId, status: failure.status });
      sendJson(response, 200, { failure });
      return;
    }
    if (method === 'POST' && failureAction === 'promote') {
      requireAdmin(actor);
      const failure = await failureCases.get(failureId);
      if (!failure) throw new HttpError(404, 'Failure case not found.');
      const candidate = await harnessRegistry.addFixtureCandidate(failure.harnessId, failure, actor.id);
      const updated = await failureCases.linkFixtureCandidate(failureId, actor.id, candidate.id);
      await store.recordAudit(actor.id, 'FAILURE_PROMOTED_TO_FIXTURE_CANDIDATE', { failureId, harnessId: failure.harnessId, fixtureCandidateId: candidate.id });
      sendJson(response, 200, { failure: updated, fixtureCandidate: candidate });
      return;
    }
  }

  if (method === 'POST' && url.pathname === '/api/ai/draft-task') {
    const body = await readBody(request);
    assertPlainObject(body);
    const [tasks, profiles, context] = await Promise.all([store.listTasks(), verifier.publicProfiles(), projectContext.get()]);
    const draft = await runTrackedAI(request, actor, 'task-draft', () => ai.draftTask({ goal: body.goal, tasks, profiles, projectContext: context }));
    await store.recordAudit(actor.id, 'AI_TASK_DRAFTED', {
      contentSha256: draft.aiMeta.contentSha256,
      model: draft.aiMeta.model,
      totalTokens: draft.aiMeta.usage.totalTokens,
    });
    sendJson(response, 200, { draft });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/ai/next-tasks') {
    const body = await readBody(request);
    assertPlainObject(body);
    const [tasks, profiles, context] = await Promise.all([store.listTasks(), verifier.publicProfiles(), projectContext.get()]);
    const result = await runTrackedAI(request, actor, 'next-tasks', () => ai.suggestNextTasks({ objective: body.objective, tasks, profiles, projectContext: context }));
    await store.recordAudit(actor.id, 'AI_NEXT_TASKS_SUGGESTED', {
      contentSha256: result.aiMeta.contentSha256,
      suggestionCount: result.suggestions.length,
      model: result.aiMeta.model,
      totalTokens: result.aiMeta.usage.totalTokens,
    });
    sendJson(response, 200, { result });
    return;
  }

  const aiTaskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/ai-(brief|verification-summary)$/);
  if (aiTaskMatch && method === 'POST') {
    const [, taskId, aiAction] = aiTaskMatch;
    const body = await readBody(request);
    assertPlainObject(body);
    const current = await store.getTask(taskId);
    if (!current) throw new HttpError(404, 'Task not found.');
    requireTaskParticipantOrAdmin(current, actor);
    const [users, context] = await Promise.all([store.listUsers(), projectContext.get()]);
    const appliedSkills = aiAction === 'brief' ? await skillRegistry.resolveActiveMany(current.skillIds ?? []) : [];
    const generated = await runTrackedAI(
      request,
      actor,
      aiAction === 'brief' ? 'task-brief' : 'verification-summary',
      () => aiAction === 'brief'
        ? ai.taskBrief({ task: current, users, skills: appliedSkills, projectContext: context })
        : ai.verificationSummary({ task: current, users, projectContext: context }),
    );
    const field = aiAction === 'brief' ? 'brief' : 'verificationSummary';
    const mutation = aiAction === 'brief' ? 'AI_TASK_BRIEF_SAVED' : 'AI_VERIFICATION_SUMMARY_SAVED';
    let task;
    try {
      task = await store.mutateTask(taskId, actor, body.expectedVersion, mutation, async (next) => {
        next.ai = next.ai ?? {};
        next.ai[field] = {
          ...generated,
          generatedByUserId: actor.id,
        };
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) {
        error.details = { ...(error.details || {}), generated, field, retryable: true };
      }
      throw error;
    }
    sendJson(response, 200, { task });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/tasks') {
    const body = await readBody(request);
    assertPlainObject(body);
    await validatePeople(body.assigneeUserId, body.reviewerUserId);
    const profileNames = await verifier.profileNames();
    const explicitProfile = body.verificationProfile != null && String(body.verificationProfile).trim() !== '';
    const explicitSkills = Object.hasOwn(body, 'skillIds');
    const activeSkillIds = await skillRegistry.activeIds();
    if (explicitSkills) await skillRegistry.resolveActiveMany(body.skillIds ?? []);
    const task = await store.createTask(actor, body, profileNames, {
      defaultProfile: explicitProfile ? null : defaultVerificationProfile(profileNames),
      autoSkillIds: body.noAutoLearning || explicitSkills ? [] : activeSkillIds,
    });
    sendJson(response, 201, { task });
    return;
  }

  const match = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(claim|verify|request-review|review|block|unblock)$/);
  if (!match || method !== 'POST') throw new HttpError(404, 'API route not found.');
  const [, taskId, action] = match;
  const body = await readBody(request);
  assertPlainObject(body);
  const expectedVersion = body.expectedVersion;

  if (action === 'claim') {
    let executor;
    try {
      executor = sanitizeExecutorInput(body.executor, { actorUserId: actor.id, at: nowIso() });
    } catch (error) {
      throw new HttpError(error.statusCode || 400, error.message);
    }
    // Scope lock: refuse to start a task whose path scope overlaps an already-active task.
    const claiming = await store.getTask(taskId);
    if (claiming) {
      const overlap = (await store.listTasks()).find((other) =>
        other.id !== taskId
        && ['IN_PROGRESS', 'REVIEW'].includes(other.status)
        && scopesOverlap(other.allowedPaths, claiming.allowedPaths));
      if (overlap) {
        throw new HttpError(409, `Scope locked: task ${overlap.id} is already active on an overlapping path scope.`);
      }
    }
    const task = await store.mutateTask(taskId, actor, expectedVersion, 'TASK_STARTED', async (next) => {
      if (next.status !== 'READY') throw new HttpError(409, 'Only READY tasks can be started.');
      if (next.assigneeUserId && next.assigneeUserId !== actor.id) throw new HttpError(403, 'This task is assigned to another user.');
      next.assigneeUserId = actor.id;
      if (next.reviewerUserId === actor.id) next.reviewerUserId = null;
      next.status = 'IN_PROGRESS';
      next.blocked = null;
      next.review = null;
      if (executor) next.executor = executor;
    });
    sendJson(response, 200, { task });
    return;
  }

  if (action === 'verify') {
    await verifier.withWorkspaceLock(async () => {
      const runningTask = await store.mutateTask(taskId, actor, expectedVersion, 'VERIFICATION_STARTED', async (next) => {
        requireAssigneeOrAdmin(next, actor);
        if (next.status !== 'IN_PROGRESS') throw new HttpError(409, 'Verification requires an IN_PROGRESS task.');
        next.verification = {
          status: 'RUNNING',
          profile: next.verificationProfile,
          startedAt: nowIso(),
          requestedByUserId: actor.id,
        };
      });

      let verification;
      try {
        verification = await verifier.runLocked(runningTask);
      } catch (error) {
        verification = {
          status: 'ERROR',
          profile: runningTask.verificationProfile,
          startedAt: runningTask.verification?.startedAt,
          finishedAt: nowIso(),
          passed: false,
          error: error.message,
        };
      }

      const recordedFailures = verification.passed
        ? []
        : await failureCases.recordVerification({ task: runningTask, verification, actorUserId: actor.id });
      verification.failureCaseIds = recordedFailures.map((item) => item.id);
      const task = await saveVerificationResult(taskId, actor, runningTask.version, verification);
      sendJson(response, 200, { task, failureCases: recordedFailures });
    });
    return;
  }

  if (action === 'request-review') {
    const current = await store.getTask(taskId);
    if (!current) throw new HttpError(404, 'Task not found.');
    requireAssigneeOrAdmin(current, actor);
    if (current.status !== 'IN_PROGRESS') throw new HttpError(409, 'Only IN_PROGRESS tasks can request review.');
    if (!current.verification?.passed) throw new HttpError(409, 'A passing verification is required.');
    if (!await verifier.fingerprintMatches(current.verification)) {
      await store.mutateTask(taskId, actor, current.version, 'VERIFICATION_STALE', async (next) => {
        next.verification = { ...next.verification, status: 'STALE', passed: false, staleAt: nowIso() };
      });
      throw new HttpError(409, 'Workspace changed after verification. Run verification again.');
    }
    if (current.reviewerUserId === current.assigneeUserId && !soloMode) throw new HttpError(409, 'Reviewer must differ from assignee.');
    const task = await store.mutateTask(taskId, actor, expectedVersion, 'REVIEW_REQUESTED', async (next) => {
      if (!next.verification?.passed || !await verifier.fingerprintMatches(next.verification)) {
        throw new HttpError(409, 'Workspace changed after verification. Run verification again.');
      }
      next.status = 'REVIEW';
      next.review = { status: 'PENDING', requestedAt: nowIso(), requestedByUserId: actor.id };
    });
    sendJson(response, 200, { task });
    return;
  }

  if (action === 'review') {
    const current = await store.getTask(taskId);
    if (!current) throw new HttpError(404, 'Task not found.');
    if (current.status !== 'REVIEW') throw new HttpError(409, 'Task is not waiting for review.');
    if (actor.id === current.assigneeUserId && !soloMode) throw new HttpError(403, 'Assignees cannot review their own task.');
    if (current.reviewerUserId && current.reviewerUserId !== actor.id) throw new HttpError(403, 'This task has a different assigned reviewer.');
    const decision = String(body.decision || '').toUpperCase();
    if (!['APPROVE', 'REJECT'].includes(decision)) throw new HttpError(400, 'Decision must be APPROVE or REJECT.');
    if (decision === 'APPROVE' && !await verifier.fingerprintMatches(current.verification)) {
      throw new HttpError(409, 'Workspace changed after verification. Approval is blocked.');
    }
    const task = await store.mutateTask(taskId, actor, expectedVersion, decision === 'APPROVE' ? 'REVIEW_APPROVED' : 'REVIEW_REJECTED', async (next) => {
      if (decision === 'APPROVE' && !await verifier.fingerprintMatches(next.verification)) {
        throw new HttpError(409, 'Workspace changed after verification. Approval is blocked.');
      }
      next.review = {
        status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
        reviewerUserId: actor.id,
        comment: String(body.comment ?? '').trim().slice(0, 2000),
        reviewedAt: nowIso(),
        solo: soloMode && actor.id === next.assigneeUserId,
      };
      if (decision === 'APPROVE') {
        next.status = 'DONE';
        next.completedAt = nowIso();
      } else {
        next.status = 'IN_PROGRESS';
        next.verification = next.verification
          ? { ...next.verification, status: 'STALE', passed: false, staleAt: nowIso() }
          : null;
      }
    });
    sendJson(response, 200, { task });
    return;
  }

  if (action === 'block') {
    const reason = String(body.reason ?? '').trim();
    if (!reason) throw new HttpError(400, 'Block reason is required.');
    const task = await store.mutateTask(taskId, actor, expectedVersion, 'TASK_BLOCKED', async (next) => {
      requireTaskParticipantOrAdmin(next, actor);
      if (next.status === 'DONE') throw new HttpError(409, 'Completed tasks cannot be blocked.');
      next.status = 'BLOCKED';
      next.blocked = { reason: reason.slice(0, 2000), byUserId: actor.id, at: nowIso() };
    });
    sendJson(response, 200, { task });
    return;
  }

  if (action === 'unblock') {
    const task = await store.mutateTask(taskId, actor, expectedVersion, 'TASK_UNBLOCKED', async (next) => {
      requireTaskParticipantOrAdmin(next, actor);
      if (next.status !== 'BLOCKED') throw new HttpError(409, 'Task is not blocked.');
      next.status = 'READY';
      next.blocked = null;
      next.verification = null;
      next.review = null;
    });
    sendJson(response, 200, { task });
  }
}

async function runTrackedAI(request, actor, feature, work) {
  const started = Date.now();
  try {
    const result = await work();
    await safeRecordUsage({
      actorUserId: actor.id,
      feature,
      model: result.aiMeta?.model || ai.status().model,
      source: requestSource(request),
      status: 'SUCCESS',
      usage: result.aiMeta?.usage,
      providerRequestId: result.aiMeta?.providerRequestId,
      durationMs: Date.now() - started,
    });
    return result;
  } catch (error) {
    await safeRecordUsage({
      actorUserId: actor.id,
      feature,
      model: ai.status().model,
      source: requestSource(request),
      status: 'FAILED',
      durationMs: Date.now() - started,
      error: error.message,
    });
    throw error;
  }
}


async function saveVerificationResult(taskId, actor, expectedVersion, verification) {
  try {
    return await store.mutateTask(taskId, actor, expectedVersion, 'VERIFICATION_FINISHED', async (next) => {
      next.verification = verification;
    });
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 409) throw error;
  }

  const latest = await store.getTask(taskId);
  if (!latest) throw new HttpError(404, 'Task not found while recording verification.');
  try {
    return await store.mutateTask(taskId, actor, latest.version, 'VERIFICATION_FINISHED_AFTER_CONFLICT', async (next) => {
      next.verification = verification;
    });
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 409) throw error;
  }

  const finalCurrent = await store.getTask(taskId);
  if (!finalCurrent) throw new HttpError(404, 'Task not found while recording verification error.');
  return store.mutateTask(taskId, actor, finalCurrent.version, 'VERIFICATION_RESULT_RECORDING_FAILED', async (next) => {
    next.verification = {
      ...verification,
      status: 'ERROR',
      passed: false,
      error: 'Verification completed, but its result could not be recorded after concurrent task updates.',
      recordingFailedAt: nowIso(),
    };
  });
}

async function safeRecordUsage(event) {
  try {
    await usageTracker.record(event);
  } catch (error) {
    console.error('AI usage logging failed:', error);
    await store.recordAudit(event.actorUserId, 'AI_USAGE_LOG_FAILED', {
      feature: event.feature,
      model: event.model,
      error: error.message,
    }).catch(() => {});
  }
}

function requestSource(request) {
  const value = String(request.headers['x-team-loop-client'] || '').toLowerCase();
  if (value === 'cli' || value === 'web') return value;
  return 'api';
}

function requireTrustedClientHeader(request) {
  const value = String(request.headers['x-team-loop-client'] || '').toLowerCase();
  if (!['web', 'cli', 'collector'].includes(value)) {
    throw new HttpError(403, 'X-Team-Loop-Client header is required for POST requests.');
  }
}

function authRateKey(request, action, name) {
  const address = request.socket?.remoteAddress || 'unknown';
  const normalizedName = String(name || '').trim().toLowerCase();
  return `${action}:${address}:${normalizedName}`;
}

async function validatePeople(assigneeUserId, reviewerUserId) {
  const users = await store.listUsers();
  const userIds = new Set(users.map((user) => user.id));
  if (assigneeUserId && !userIds.has(assigneeUserId)) throw new HttpError(400, 'Assignee not found.');
  if (reviewerUserId && !userIds.has(reviewerUserId)) throw new HttpError(400, 'Reviewer not found.');
  if (assigneeUserId && reviewerUserId && assigneeUserId === reviewerUserId) {
    throw new HttpError(400, 'Reviewer must differ from assignee.');
  }
}

function defaultVerificationProfile(profileNames) {
  if (profileNames.includes('repository-basic')) return 'repository-basic';
  return profileNames[0] ?? null;
}

function requireAdmin(actor) {
  if (actor.role !== 'admin') throw new HttpError(403, 'Administrator access is required.');
}

function requireAssigneeOrAdmin(task, actor) {
  if (task.assigneeUserId !== actor.id && actor.role !== 'admin') throw new HttpError(403, 'Only the assignee can do this.');
}

function requireTaskParticipantOrAdmin(task, actor) {
  if (![task.creatorUserId, task.assigneeUserId, task.reviewerUserId].includes(actor.id) && actor.role !== 'admin') {
    throw new HttpError(403, 'Only a task participant can do this.');
  }
}

async function requireUser(request) {
  const token = parseCookies(request.headers.cookie).team_loop_session;
  const session = readSession(sessionSecret, token);
  if (!session) throw new HttpError(401, 'Authentication required.');
  const user = await store.getUser(session.userId);
  if (!user) throw new HttpError(401, 'Session user no longer exists.');
  return user;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const target = path.resolve(publicRoot, `.${requested}`);
  if (!target.startsWith(`${publicRoot}${path.sep}`) && target !== path.join(publicRoot, 'index.html')) {
    throw new HttpError(403, 'Forbidden.');
  }
  try {
    const content = await readFile(target);
    response.writeHead(200, {
      'Content-Type': mimeType(target),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    response.end(content);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new HttpError(404, 'Not found.');
    throw error;
  }
}

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
  }[extension] || 'application/octet-stream';
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function sendError(response, error) {
  const status = error instanceof HttpError ? error.status : 500;
  if (status >= 500) console.error(error);
  sendJson(response, status, {
    error: error.message || 'Internal server error.',
    details: error instanceof HttpError ? error.details : undefined,
  });
}
