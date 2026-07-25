import http from 'node:http';
import path from 'node:path';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { clearSessionCookie, issueSession, loadOrCreateSecret, parseCookies, readSession, sessionCookie } from './src/auth.js';
import { Store } from './src/store.js';
import { Verifier } from './src/verifier.js';
import { AIService } from './src/ai.js';
import { UsageTracker } from './src/usage.js';
import { HarnessRegistry } from './src/harness-registry.js';
import { FailureCaseStore } from './src/failure-cases.js';
import { SkillRegistry } from './src/skill-registry.js';
import { FailureLearningService } from './src/failure-learning.js';
import { sanitizeExecutorInput } from './src/executor.js';
import { executionMode } from './public/task-execution.js';
import { canReviewTask } from './public/review-policy.js';
import { existsSync } from 'node:fs';
import { findActiveScopeOverlap, scopesOverlap } from './src/scope.js';
import { mergeTaskWorktree, removeTaskWorktree, taskBranchMerged, worktreeHasChanges, worktreePath } from './src/worktree.js';
import { applyRemoteTaskSubmission, readRemoteTaskFiles } from './src/remote-submission.js';
import { ProjectContextStore } from './src/project-context.js';
import { DiscussionStore } from './src/discussions.js';
import { FixedWindowRateLimiter } from './src/rate-limit.js';
import { selectLearningForTask } from './src/learning-selector.js';
import { auditLearningArtifacts } from './src/learning-audit.js';
import { ContextIndex } from './src/context-index.js';
import { AISessionLogStore } from './src/ai-session-logs.js';
import { RunDashboardStore } from './src/run-dashboard.js';
import { ScopeLeaseService } from './src/scope-leases.js';
import { assertPlainObject, HttpError, nowIso, randomId, sha256 } from './src/utils.js';
import { WorkboardEngine } from './src/engine/workboard-engine.js';
import { renderStandaloneWorkboard } from './src/engine/standalone-workboard.js';
import { WikiStore } from './src/wiki-store.js';
import { ExperienceJournal } from './src/experience-journal.js';
import { ExperienceEngine } from './src/experience-engine.js';
import { CONTRACT_VERSION, KNOWLEDGE_PROMOTION_CONTRACT } from './src/contracts.js';
import { BalanceExperimentStore } from './src/balance-experiments.js';
import { BalanceSeedRegistry } from './src/balance-seeds.js';
import { BalanceJobManager } from './src/balance-jobs.js';
import { BalancePortfolioStore } from './src/balance-portfolio.js';
import { handleBalanceRoute } from './src/http/balance-routes.js';
import { ContextPackStore, ContextSeedRegistry } from './src/context-packs.js';
import { PromotionEngine } from './src/promotion-engine.js';
import { EntryService } from './src/entry-service.js';
import { ConstitutionCompiler, ConstitutionObservationStore } from './src/constitution.js';
import { OrchestrationEngine } from './src/orchestration-engine.js';
import { IdleRunner } from './src/idle-runner.js';
import { TurnBudgetObservationStore, retainExecutorReport } from './src/turn-budget-observations.js';
import { decideWorkBudget } from './src/work-budget.js';
import { selectContextTier } from './src/cli/main.js';
import { AuctionPlaySessionStore } from './src/auction-play-sessions.js';
import { effectiveAutomationTokens, recordAutomationResult } from './src/automation-guard.js';
import {
  buildMaxTurnRecoveryPlan,
  isExhaustedMaxTurnFailure,
  isRecoverablePartialMaxTurnFailure,
  terminalMaxTurnDecision,
} from './src/max-turn-decomposition.js';
import { selectAutomaticNextPlanTask } from './src/plan-progression.js';
import { applyAgentDeliveryGate } from './src/delivery-gate.js';
import { classifyDeliveryFailure } from './src/delivery-failures.js';
import { loadConfig } from './src/cli/session.js';
import { normalizeWorkerConfig, selectExecutor, selectReviewer } from './src/executor-router.js';
import { readWorkspaceHandoff } from './src/workspace-manager.js';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(projectRoot, 'public');
const dataDirectory = path.resolve(process.env.DATA_DIR || path.join(projectRoot, 'data'));
const taskArtifactRoot = path.join(dataDirectory, 'task-artifacts');
const workspaceRoot = path.resolve(process.env.WORKSPACE_ROOT || projectRoot);
const profilePath = path.resolve(process.env.VERIFICATION_PROFILES || path.join(projectRoot, 'config', 'verification-profiles.json'));
const learningSeedPath = path.resolve(process.env.LEARNING_SEEDS || path.join(projectRoot, 'config', 'learning-seeds.json'));
const usageConfigPath = path.resolve(process.env.USAGE_CONFIG || path.join(projectRoot, 'config', 'usage-dashboard.json'));
const balanceSeedManifestPath = path.resolve(process.env.BALANCE_SEEDS || path.join(projectRoot, 'config', 'balance-seeds.json'));
const contextSeedManifestPath = path.resolve(process.env.CONTEXT_SEEDS || path.join(projectRoot, 'config', 'context-seeds.json'));
const promotionPolicyPath = path.resolve(process.env.PROMOTION_POLICY || path.join(projectRoot, 'config', 'promotion-policy.json'));
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 4173);
const secureCookies = process.env.SECURE_COOKIES === 'true';
const signupCode = process.env.SIGNUP_CODE || '';
const soloMode = process.env.SOLO_MODE === 'true';
const serverStartedAt = Date.now();
const authRateLimiter = new FixedWindowRateLimiter({ limit: 10, windowMs: 60_000 });
const boardWorkers = new Map();

const store = new Store(dataDirectory, { signupCode, serverStartedAt });
const harnessRegistry = new HarnessRegistry({ dataDirectory, seedProfilePath: profilePath, workspaceRoot });
const verifier = new Verifier({ workspaceRoot, harnessRegistry, runtimeRoot: projectRoot });
const failureCases = new FailureCaseStore(dataDirectory);
const skillRegistry = new SkillRegistry({ dataDirectory, seedSkillPath: learningSeedPath });
const learning = new FailureLearningService({ failureCases, harnessRegistry, skillRegistry });
const projectContext = new ProjectContextStore(dataDirectory);
const discussions = new DiscussionStore(dataDirectory);
const ai = new AIService();
const usageTracker = new UsageTracker({ dataDirectory, configPath: usageConfigPath });
const contextIndex = new ContextIndex({ workspaceRoot });
const aiSessionLogs = new AISessionLogStore();
const runDashboard = new RunDashboardStore({ workspaceRoot });
const runScopes = new ScopeLeaseService({ workspaceRoot });
const workboardEngine = new WorkboardEngine();
const wiki = new WikiStore(dataDirectory);
const experienceJournal = new ExperienceJournal(dataDirectory);
const balanceExperiments = new BalanceExperimentStore(dataDirectory);
const balancePortfolio = new BalancePortfolioStore(dataDirectory);
const balanceJobs = new BalanceJobManager({
  dataDirectory,
  async onComplete({ actor, request, result }) {
    const experiment = await balanceExperiments.record(actor, request, result);
    await balancePortfolio.capture(experiment);
    return experiment;
  },
});
const balanceSeeds = new BalanceSeedRegistry({ projectRoot, manifestPath: balanceSeedManifestPath });
const auctionPlaySessions = new AuctionPlaySessionStore({
  dataDirectory,
  seedPath: path.join(projectRoot, 'examples', 'balance', 'unknown-auction-economy.json'),
});
const contextSeeds = new ContextSeedRegistry(contextSeedManifestPath);
const contextPacks = new ContextPackStore({ dataDirectory, workspaceRoot });
// 팩을 조립해 턴 예산을 도출한다. 팩이 이 일에 무엇이 실제로 필요한지 아는 유일한 실체다.
// 조립에 실패하면 예산을 지어내지 않고 가장 좁은 값으로 떨어뜨린 뒤 그 사실을 남긴다.
// 조립한 팩을 버리지 않고 기록·잠금까지 해서 id를 남긴다. 워커는 그 id로 같은 팩을 받아가므로
// 같은 조립을 두 번 하지 않고, 예산을 정할 때 본 것과 실행자가 받는 것이 같음이 보장된다.
async function deriveWorkBudget(task, actor) {
  try {
    const seed = contextSeeds.get(selectContextTier(task)) ?? contextSeeds.get('implementation');
    if (!seed) throw new HttpError(404, 'Context seed not found.');
    const pack = await experienceEngine.prepare({
      goal: task.title,
      description: task.description,
      allowedPaths: task.allowedPaths || [],
      acceptanceCriteria: task.acceptanceCriteria || [],
      defaultHarnessId: task.verificationProfile,
      maxWikiEntries: seed.maxWikiEntries,
      maxSourceChunks: seed.maxSourceChunks,
      maxSourceCharacters: seed.maxSourceCharacters,
      forbiddenActions: seed.forbiddenActions,
    });
    pack.layers = seed.layers;
    const record = await contextPacks.record(actor, seed, pack, null);
    const locked = await contextPacks.lockPack(record.id, actor);
    await store.recordAudit(actor.id, 'CONTEXT_PACK_PREPARED', {
      contextPackId: record.id,
      packId: pack.contract.packId,
      seedId: seed.id,
      sourceCount: pack.sources.sourceCount,
      estimatedTokens: pack.sources.estimatedTokens,
      preparedFor: task.id,
    });
    return {
      ...decideWorkBudget({ pack, allowedPaths: task.allowedPaths }),
      packPrepared: true,
      contextPackId: locked.id,
      contextPackReceiptId: locked.receipt?.receiptId ?? null,
    };
  } catch (error) {
    // 팩을 세우지 못하면 상한만 돌려주고 워커가 스스로 조립하게 둔다. 실패를 감추지는 않는다.
    return {
      ...decideWorkBudget({ pack: null, allowedPaths: task.allowedPaths }),
      packPrepared: false,
      contextPackId: null,
      contextPackReceiptId: null,
      packError: String(error?.message || error).slice(0, 300),
    };
  }
}

// 승격 대상 산출물이 딸린 실패 사례를 거쳐 실제로 그 실패를 만든 태스크의 실행자를
// 찾는다. sourceFailureCaseIds -> failure.taskIds -> task.executorProfileId 순서로
// 이미 기록된 사슬만 따라가며, 설정 기본 실행자를 대리인으로 쓰지 않는다.
async function resolveProducerProfileIds(artifact) {
  const failureCaseIds = Array.isArray(artifact?.sourceFailureCaseIds) ? artifact.sourceFailureCaseIds : [];
  const taskIds = new Set();
  for (const failureCaseId of failureCaseIds) {
    const failureCase = await failureCases.get(failureCaseId);
    for (const taskId of failureCase?.taskIds || []) taskIds.add(taskId);
  }
  const producerProfileIds = new Set();
  for (const taskId of taskIds) {
    const task = await store.getTask(taskId);
    if (task?.executorProfileId) producerProfileIds.add(task.executorProfileId);
  }
  return [...producerProfileIds];
}

// ADR-002 독립 관찰자 원칙을 승격에 적용한다: 태스크 리뷰와 같은 라우팅을 재사용해
// 산출물을 만든 프로필과 다른 프로필이 검증할 수 있을 때만 자동 활성화를 허용한다.
// 제작 주체는 config 기본 실행자를 대신 쓰지 않고, 실제로 기록된 실패-태스크 사슬로만 정한다.
async function resolvePromotionReview({ artifact }) {
  const config = await loadConfig();
  const producerProfileIds = await resolveProducerProfileIds(artifact);
  if (!producerProfileIds.length) {
    return { independent: false, reason: 'PRODUCER_UNKNOWN', reviewerProfileId: null, producerProfileIds };
  }
  const selection = selectReviewer({}, config, { quality: 'high', executorProfileId: producerProfileIds[0] });
  if (!selection.candidate) return { independent: false, reason: 'NO_REVIEWER', reviewerProfileId: null, producerProfileIds };
  const independent = !producerProfileIds.includes(selection.candidate.id);
  return {
    independent,
    reason: independent ? null : 'SAME_PROFILE_FALLBACK',
    reviewerProfileId: selection.candidate.id,
    producerProfileIds,
  };
}

const promotionEngine = new PromotionEngine({ dataDirectory, policyPath: promotionPolicyPath, failureCases, harnessRegistry, skillRegistry, wikiStore: wiki, resolveIndependentReview: resolvePromotionReview });
const entryService = new EntryService({ dataDirectory, workspaceRoot });
const turnBudgetObservations = new TurnBudgetObservationStore(dataDirectory);
const constitutionCompiler = new ConstitutionCompiler({
  sourcePath: path.join(projectRoot, 'docs', 'AGENT-CONSTITUTION.md'),
  outputDirectory: path.join(dataDirectory, 'generated', 'constitution'),
});
const constitutionObservations = new ConstitutionObservationStore(dataDirectory);
const orchestrationEngine = new OrchestrationEngine({ constitutionCompiler, entryService });

// 유휴 판정은 프록시가 아니라 권위 있는 신호로 한다: 살아있는 워커와 태스크 실행 상태.
async function workspaceIdleState() {
  if (boardWorkers.size) return { idle: false, reason: 'BOARD_WORKER_ACTIVE' };
  const tasks = await store.listTasks();
  const busy = tasks.find((task) => !task.archived && ['RUNNING', 'QUEUED', 'RECOVERING'].includes(String(task.executionState || '')));
  if (busy) return { idle: false, reason: `TASK_${busy.executionState}` };
  return { idle: true, reason: null };
}

// 주입 실증을 fixture 후보에 반영한다. 주입은 "이 하네스가 심은 결함을 잡는다"를 증명할 뿐이므로,
// 후보의 실패 종류가 일치할 때만 표시한다. 종류가 다르면 그 후보는 여전히 미증명이다.
async function recordInjectionReplays(report) {
  let recorded = 0;
  for (const result of report.results) {
    const harnesses = await harnessRegistry.findByCommandScript(result.harness).catch(() => []);
    for (const harness of harnesses) {
      for (const candidate of harness.fixtureCandidates ?? []) {
        if (!String(candidate.name || '').startsWith('exit_mismatch')) continue;
        await harnessRegistry.recordFixtureReplay(harness.id, candidate.id, {
          name: result.name,
          injectedExit: result.injectedExit,
          restoredExit: result.restoredExit,
          caught: result.caught,
          detail: result.detail,
        }, 'system').then(() => { recorded += 1; }).catch(() => {});
      }
    }
  }
  return recorded;
}

// 유휴에 도는 무비용 검증. 토큰을 쓰지 않고 전용 worktree 안에서만 변형한다.
const idleVerifier = new IdleRunner({
  name: 'harness-injection-simulation',
  isIdle: workspaceIdleState,
  intervalMs: Number(process.env.TEAM_LOOP_IDLE_INTERVAL_MS) || 5 * 60_000,
  minGapMs: Number(process.env.TEAM_LOOP_IDLE_MIN_GAP_MS) || 60 * 60_000,
  run: async () => {
    const raw = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(projectRoot, 'tools', 'verification', 'check-harness-injection.mjs'), '--json'], {
        cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { err += chunk; });
      child.on('error', (error) => resolve({ code: 1, out: '', err: String(error.message) }));
      child.on('close', (code) => resolve({ code, out, err }));
    });
    let report = null;
    try { report = JSON.parse(raw.out); } catch { report = null; }
    if (!report) {
      return { ok: false, exitCode: raw.code, summary: (raw.err || raw.out).trim().slice(-400) || 'no output' };
    }
    const replays = await recordInjectionReplays(report);
    const caught = report.results.filter((item) => item.caught).length;
    return {
      ok: raw.code === 0,
      exitCode: raw.code,
      summary: `${caught}/${report.results.length} faults caught, ${replays} fixture replay(s) recorded, ${report.unproven.length} unproven`,
    };
  },
  onResult: (outcome) => {
    if (outcome.circuitOpened) {
      // 반복 실패는 조용히 지나가면 안 된다. 스케줄은 이미 멈췄고, 사람이 볼 자리에 남긴다.
      console.error(`IDLE VERIFICATION STOPPED after ${outcome.failures} consecutive failures: ${outcome.result?.summary ?? outcome.error ?? 'no detail'}`);
      store.recordAudit('system', 'IDLE_VERIFICATION_CIRCUIT_OPENED', {
        job: outcome.name, failures: outcome.failures, summary: outcome.result?.summary ?? outcome.error ?? null,
      }).catch(() => {});
    }
    if (!outcome.ran) return;
    store.recordAudit('system', 'IDLE_VERIFICATION_RUN', {
      job: outcome.name, reason: outcome.reason, ok: outcome.result?.ok ?? false, summary: outcome.result?.summary ?? outcome.error ?? null,
    }).catch(() => {});
  },
});
const experienceEngine = new ExperienceEngine({
  projectContext, contextIndex, wiki, failureCases, harnessRegistry, skillRegistry,
});
await Promise.all([store.initialize(), harnessRegistry.initialize(), failureCases.initialize(), skillRegistry.initialize(), projectContext.initialize(), discussions.initialize(), usageTracker.initialize(), contextIndex.initialize(), wiki.initialize(), balanceExperiments.initialize(), balancePortfolio.initialize(), balanceJobs.initialize(), balanceSeeds.initialize(), auctionPlaySessions.initialize(), contextSeeds.initialize(), contextPacks.initialize(), promotionEngine.initialize(), entryService.initialize(), constitutionObservations.initialize()]);
const initialWorkerConfig = await loadConfig();
const initialExecutionProfile = selectExecutor({ priority: 100 }, initialWorkerConfig).candidate;
const initialReviewProfile = selectReviewer({ priority: 100 }, initialWorkerConfig, {
  executorProfileId: initialExecutionProfile?.id || '',
}).candidate;
await store.initializeAiProfiles({
  executorProfileId: initialExecutionProfile?.id,
  reviewerProfileId: initialReviewProfile?.id,
  approvalPolicy: 'USER_CONFIRM',
});
const recoveryId = randomId('recovery_');
const recoveredAgentTaskIds = await store.recoverInterruptedAgentTasks({ recoveryId });
if (recoveredAgentTaskIds.length) {
  console.warn(`Recovered ${recoveredAgentTaskIds.length} interrupted agent task(s): ${recoveredAgentTaskIds.join(', ')}`);
}
const capturedPortfolioIds = new Set((await balancePortfolio.list({ limit: 1_000 })).map((item) => item.experimentId));
for (const experiment of await balanceExperiments.list({ limit: 100 })) {
  if (!capturedPortfolioIds.has(experiment.id)) await balancePortfolio.capture(experiment);
}
await constitutionCompiler.compile();
await failureCases.resolveCoveredByActiveArtifacts({
  harnessIds: (await harnessRegistry.list({ includeDisabled: false })).map((item) => item.id),
  skillIds: (await skillRegistry.list({ includeDisabled: false })).map((item) => item.id),
}, 'system');
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

server.listen(port, host, async () => {
  const address = server.address();
  const listeningPort = typeof address === 'object' && address ? address.port : port;
  console.log(`Team Loop Lite listening on http://${host}:${listeningPort}`);
  console.log(`Workspace: ${workspaceRoot}`);
  if (!signupCode) {
    console.warn('WARNING: SIGNUP_CODE is not configured. The first administrator may register only during the first 10 minutes after startup.');
  }
  for (const taskId of recoveredAgentTaskIds) {
    await recoverPersistedAgentTask(taskId).catch((error) => {
      console.error(`Agent recovery failed for ${taskId}: ${error.message}`);
    });
  }
  // 유휴 검증은 무비용·로컬·되돌릴 수 있어 자동 실행이 허용되는 부류다. 끄려면 TEAM_LOOP_IDLE_VERIFY=off.
  if (String(process.env.TEAM_LOOP_IDLE_VERIFY || 'on').toLowerCase() !== 'off') {
    idleVerifier.start();
    const { intervalMs, minGapMs } = idleVerifier.status();
    console.log(`Idle verification scheduled: every ${Math.round(intervalMs / 1000)}s, at most once per ${Math.round(minGapMs / 60000)}min`);
  } else {
    console.log('Idle verification disabled by TEAM_LOOP_IDLE_VERIFY=off');
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

  if (method === 'GET' && url.pathname === '/api/events/work') {
    await streamWorkEvents(request, response, actor);
    return;
  }

  const userStatusMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/(disable|enable)$/);
  if (method === 'POST' && userStatusMatch) {
    const user = await store.setUserDisabled(actor, decodeURIComponent(userStatusMatch[1]), userStatusMatch[2] === 'disable');
    sendJson(response, 200, { user });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/constitution') {
    sendJson(response, 200, { constitution: constitutionCompiler.status() });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/constitution/audit') {
    sendJson(response, 200, {
      audit: await constitutionObservations.audit(constitutionCompiler.status().constitutionVersion, { limit: url.searchParams.get('limit') }),
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/constitution/compile') {
    requireAdmin(actor);
    const constitution = await constitutionCompiler.compile();
    await store.recordAudit(actor.id, 'CONSTITUTION_COMPILED', {
      constitutionVersion: constitution.constitutionVersion,
      sourceSha256: constitution.sourceSha256,
    });
    sendJson(response, 200, { constitution });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/orchestration/enter') {
    const body = await readBody(request);
    assertPlainObject(body);
    const decision = await orchestrationEngine.enter(body, await store.listTasks());
    await constitutionObservations.record(actor, decision);
    await store.recordAudit(actor.id, 'ORCHESTRATION_ENTRY_DECIDED', {
      decision: decision.decision,
      reasonCode: decision.reasonCode,
      projectId: decision.project?.id || null,
      taskId: decision.work?.id || null,
      constitutionVersion: decision.constitutionVersion,
    });
    sendJson(response, 200, { decision });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/orchestration/preview-next') {
    const body = await readBody(request);
    assertPlainObject(body);
    const decision = await orchestrationEngine.enter(body, await store.listTasks());
    const config = await loadConfig();
    const selection = decision.work
      ? selectExecutor(decision.work, config, {
        quality: String(body.quality || 'auto'),
        allowRemote: body.localOnly ? false : undefined,
        executorId: String(body.executorId || ''),
      })
      : { executor: null, candidate: null, reason: 'NO_WORK' };
    const reviewerSelection = decision.work
      ? selectReviewer(decision.work, config, {
        quality: 'high',
        allowRemote: body.localOnly ? false : undefined,
        reviewerProfileId: String(body.reviewerProfileId || ''),
        executorProfileId: selection.candidate?.id || String(body.executorId || ''),
      })
      : { reviewer: null, candidate: null, reason: 'NO_WORK' };
    const usage = await usageTracker.summary({ days: 7, users: [actor], actorUserIds: [actor.id] });
    sendJson(response, 200, {
      decision,
      selection,
      reviewerSelection,
      usage: {
        generatedAt: usage.generatedAt,
        period: usage.period,
        totals: usage.bySource.find((item) => item.source === 'cli') || {
          requests: 0, successfulRequests: 0, failedRequests: 0, totalTokens: 0, durationMs: 0,
        },
      },
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/orchestration/start-next') {
    const body = await readBody(request);
    assertPlainObject(body);
    const tasks = await store.listTasks();
    const decision = await orchestrationEngine.enter(body, tasks);
    await constitutionObservations.record(actor, decision);
    if (decision.decision !== 'YES' || !decision.work) {
      sendJson(response, 200, { outcome: decision.decision, decision, task: null });
      return;
    }
    const current = await store.getTask(decision.work.id);
    if (!current) throw new HttpError(409, 'Selected work no longer exists.');
    if (current.executionState === 'RECOVERING') {
      sendJson(response, 200, { outcome: 'RECOVERING', decision, task: current, worker: null });
      return;
    }
    if (current.status === 'IN_PROGRESS' && current.verification?.passed) {
      sendJson(response, 200, {
        outcome: 'REVIEW_REQUIRED',
        decision,
        task: current,
        worker: null,
        nextAction: { name: 'request_review', taskId: current.id },
      });
      return;
    }
    if (current.status !== 'READY') {
      const worker = body.launchWorker && current.executionMode === 'AGENT'
        ? launchBoardWorker(current, actor, workerSessionCookie(request), body)
        : null;
      sendJson(response, 200, { outcome: 'RESUMED', decision, task: current, worker });
      return;
    }
    await requireCompletedDependencies(current);
    await requireAvailableTaskScope(current);
    if (current.assigneeUserId && current.assigneeUserId !== actor.id) {
      sendJson(response, 200, { outcome: 'ASK', decision, task: current, reason: 'Selected work belongs to another user.' });
      return;
    }
    const executionModeValue = String(body.executionMode || 'HUMAN').toUpperCase() === 'AGENT' ? 'AGENT' : 'HUMAN';
    const config = await loadConfig();
    // 팩을 먼저 조립하고 그 사실에서 예산을 정한다. 반대 순서로는 "파일 하나만 고치는 일"과
    // "파일 하나만 고치되 참조를 읽어야 하는 일"이 같은 예산을 받고, 후자는 빈손으로 끝난다.
    const workBudget = await deriveWorkBudget(current, actor);
    const executionSelection = selectExecutor(current, config, {
      quality: String(body.quality || 'auto'),
      allowRemote: body.localOnly ? false : undefined,
      executorId: String(body.executorId || current.executorProfileId || ''),
    });
    const reviewSelection = selectReviewer(current, config, {
      quality: 'high',
      allowRemote: body.localOnly ? false : undefined,
      reviewerProfileId: String(body.reviewerProfileId || current.reviewerProfileId || ''),
      executorProfileId: executionSelection.candidate?.id || '',
    });
    if (executionModeValue === 'AGENT' && !executionSelection.candidate) throw new HttpError(409, 'No execution AI profile is available.');
    if (executionModeValue === 'AGENT' && !reviewSelection.candidate) throw new HttpError(409, 'No review AI profile is available.');
    const task = await store.mutateTask(current.id, actor, current.version, 'TASK_AUTO_QUEUED', async (next) => {
      next.assigneeUserId = actor.id;
      next.reviewerUserId = null;
      next.executorProfileId = executionSelection.candidate?.id || null;
      next.reviewerProfileId = reviewSelection.candidate?.id || null;
      next.approvalPolicy = normalizeApprovalPolicy(body.approvalPolicy || next.approvalPolicy);
      next.executionMode = executionModeValue;
      next.executionState = executionModeValue === 'AGENT' ? 'QUEUED' : 'IDLE';
      if (executionModeValue === 'HUMAN') next.status = 'IN_PROGRESS';
      next.blocked = null;
      next.review = null;
      if (executionSelection.executor) next.executor = sanitizeExecutorInput(executionSelection.executor, { actorUserId: actor.id, at: nowIso() });
      // 예산을 무엇에서 정했는지 남긴다. 관측이 쌓이면 이 기록으로 값을 고친다.
      next.workBudget = workBudget;
    });
    await store.recordAudit(actor.id, 'ORCHESTRATION_WORK_STARTED', {
      taskId: task.id,
      planId: task.planId,
      executionMode: task.executionMode,
      reasonCode: decision.reasonCode,
    });
    const worker = body.launchWorker && executionModeValue === 'AGENT'
      // 호출자가 명시하지 않으면 팩에서 정한 예산을 쓴다. 워커가 스스로 상수를 고르지 않게 한다.
      ? launchBoardWorker(task, actor, workerSessionCookie(request), { maxTurns: workBudget.maxTurns, ...body })
      : null;
    sendJson(response, 200, { outcome: executionModeValue === 'AGENT' ? 'QUEUED' : 'STARTED', decision, task, worker, workBudget });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/entry') {
    sendJson(response, 200, await entryService.portfolio(await store.listTasks()));
    return;
  }

  if (method === 'POST' && url.pathname === '/api/projects') {
    const body = await readBody(request);
    assertPlainObject(body);
    const project = await entryService.register(actor, body);
    await store.recordAudit(actor.id, 'PROJECT_REGISTERED', { projectId: project.id });
    sendJson(response, 201, { project });
    return;
  }

  const projectEntryMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/entry$/);
  if (method === 'GET' && projectEntryMatch) {
    const [tasks, audits] = await Promise.all([store.listTasks(), store.listAuditEvents()]);
    sendJson(response, 200, await entryService.projectEntry(decodeURIComponent(projectEntryMatch[1]), tasks, audits));
    return;
  }

  const readPlanMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/read-plan$/);
  if (method === 'GET' && readPlanMatch) {
    sendJson(response, 200, await entryService.readPlan(decodeURIComponent(readPlanMatch[1]), {
      intent: url.searchParams.get('intent') || 'enter',
      workId: url.searchParams.get('workId') || null,
      maxTokens: url.searchParams.get('maxTokens'),
    }));
    return;
  }

  if (method === 'POST' && url.pathname === '/api/orchestration/delegate') {
    const body = await readBody(request);
    assertPlainObject(body);
    const parentTaskId = String(body.parentTaskId || '').trim();
    const parent = parentTaskId ? await store.getTask(parentTaskId) : null;
    if (parentTaskId && !parent) throw new HttpError(404, 'Parent task not found.');
    if (parent) requireTaskParticipantOrAdmin(parent, actor);
    const depth = Number(parent?.delegation?.depth || 0) + 1;
    const maxDepth = Math.max(1, Math.min(2, Number(body.maxDepth) || 2));
    if (depth > maxDepth || depth > 2) throw new HttpError(409, 'Delegation depth limit reached.');
    const role = String(body.role || 'EXECUTE').toUpperCase() === 'REVIEW' ? 'REVIEW' : 'EXECUTE';
    const reason = String(body.reason || '').trim().slice(0, 1000);
    if (!reason) throw new HttpError(400, 'Delegation reason is required.');
    const allowedPaths = Array.isArray(body.allowedPaths) && body.allowedPaths.length
      ? body.allowedPaths
      : parent?.allowedPaths || ['**'];
    const fingerprint = sha256(JSON.stringify({
      parentTaskId: parentTaskId || null,
      role,
      reason: reason.toLowerCase(),
      allowedPaths: [...allowedPaths].map(String).sort(),
    }));
    const duplicate = (await store.listTasks()).find((item) =>
      !item.archived && item.status !== 'DONE' && item.delegation?.fingerprint === fingerprint);
    if (duplicate) {
      sendJson(response, 200, { outcome: 'REUSED', task: duplicate, launched: false });
      return;
    }

    const config = await loadConfig();
    const targetProfileId = String(body.targetProfileId || '').trim();
    const executionSelection = role === 'REVIEW'
      ? selectReviewer(parent || body, config, {
        reviewerProfileId: targetProfileId,
        executorProfileId: String(body.requestedByProfileId || parent?.executorProfileId || ''),
      })
      : selectExecutor(parent || body, config, { executorId: targetProfileId });
    const target = executionSelection.candidate;
    if (!target) throw new HttpError(409, `No ${role.toLowerCase()} AI profile is available for delegation.`);
    const independentReview = selectReviewer(parent || body, config, {
      executorProfileId: target.id,
    });
    if (!independentReview.candidate) throw new HttpError(409, 'No independent review profile is available for delegated work.');
    const tokenBudget = Math.max(1_000, Math.min(
      Number(parent?.delegation?.budget?.tokenBudget || 500_000),
      Number(body.tokenBudget) || 500_000,
    ));
    const costBudgetUsd = Math.max(0.01, Math.min(
      Number(parent?.delegation?.budget?.costBudgetUsd || 10),
      Number(body.costBudgetUsd) || 10,
    ));
    const taskInput = {
      title: String(body.title || `Delegated ${role.toLowerCase()} work`).slice(0, 120),
      description: String(body.description || reason).slice(0, 4000),
      priority: Number(body.priority || parent?.priority || 100),
      allowedPaths,
      acceptanceCriteria: Array.isArray(body.acceptanceCriteria) ? body.acceptanceCriteria : [],
      verificationProfile: String(body.verificationProfile || parent?.verificationProfile || 'repository-basic'),
      assigneeUserId: actor.id,
      reviewerUserId: null,
      executorProfileId: target.id,
      reviewerProfileId: independentReview.candidate.id,
      approvalPolicy: normalizeApprovalPolicy(body.approvalPolicy || 'USER_CONFIRM'),
      noAutoLearning: false,
      delegation: {
        parentTaskId: parentTaskId || null,
        rootTaskId: parent?.delegation?.rootTaskId || parentTaskId || null,
        depth,
        role,
        reason,
        fingerprint,
        requestedByProfileId: String(body.requestedByProfileId || parent?.executorProfileId || ''),
        targetProfileId: target.id,
        budget: {
          tokenBudget,
          costBudgetUsd,
          maxCalls: Math.max(1, Math.min(5, Number(body.maxCalls) || 2)),
        },
      },
    };
    const task = await store.createTask(actor, taskInput, await verifier.profileNames());
    const queued = await store.mutateTask(task.id, actor, task.version, 'TASK_DELEGATED', async (next) => {
      next.executionMode = 'AGENT';
      next.executionState = 'QUEUED';
      next.executor = sanitizeExecutorInput(
        { tool: target.tool, model: target.model || '' },
        { actorUserId: actor.id, at: nowIso() },
      );
    });
    await store.recordAudit(actor.id, 'WORK_DELEGATED', {
      taskId: queued.id,
      parentTaskId: parentTaskId || null,
      role,
      depth,
      targetProfileId: target.id,
      fingerprint,
    });
    const worker = body.launchWorker === true
      ? launchBoardWorker(queued, actor, workerSessionCookie(request), {
        executorId: target.id,
        reviewerProfileId: independentReview.candidate.id,
      })
      : null;
    sendJson(response, 201, { outcome: worker ? 'LAUNCHED' : 'QUEUED', task: queued, worker, launched: Boolean(worker) });
    return;
  }

  const delegationStatusMatch = url.pathname.match(/^\/api\/orchestration\/delegations\/([^/]+)$/);
  if (method === 'GET' && delegationStatusMatch) {
    const taskId = decodeURIComponent(delegationStatusMatch[1]);
    const task = await store.getTask(taskId);
    if (!task) throw new HttpError(404, 'Delegated task not found.');
    requireTaskParticipantOrAdmin(task, actor);
    const children = (await store.listTasks())
      .filter((item) => item.delegation?.parentTaskId === task.id)
      .map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status,
        executionState: item.executionState,
        targetProfileId: item.delegation?.targetProfileId,
        depth: item.delegation?.depth,
        verification: item.verification ? { status: item.verification.status, passed: Boolean(item.verification.passed) } : null,
      }));
    sendJson(response, 200, {
      task,
      children,
      result: task.status === 'DONE' ? task.review || task.verification || null : null,
    });
    return;
  }

  const projectHandoffMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/handoff$/);
  if (method === 'GET' && projectHandoffMatch) {
    const projectId = decodeURIComponent(projectHandoffMatch[1]);
    sendJson(response, 200, {
      handoff: await readWorkspaceHandoff(projectRoot, projectId),
    });
    return;
  }

  const workEntryMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/works\/([^/]+)$/);
  if (method === 'GET' && workEntryMatch) {
    const [, projectId, workId] = workEntryMatch.map(decodeURIComponent);
    const [task, audits] = await Promise.all([store.getTask(workId), store.listAuditEvents()]);
    sendJson(response, 200, await entryService.inspectWork(projectId, workId, task, audits));
    return;
  }

  const handoffMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/works\/([^/]+)\/handoff$/);
  if (handoffMatch) {
    const projectId = decodeURIComponent(handoffMatch[1]);
    const workId = decodeURIComponent(handoffMatch[2]);
    if (method === 'GET') {
      sendJson(response, 200, { handoff: await entryService.latestHandoff(projectId, workId) });
      return;
    }
    if (method === 'POST') {
      const body = await readBody(request);
      assertPlainObject(body);
      const [task, audits] = await Promise.all([store.getTask(workId), store.listAuditEvents()]);
      const handoff = await entryService.writeHandoff(actor, projectId, task, audits, body);
      await store.recordAudit(actor.id, 'WORK_HANDOFF_WRITTEN', { projectId, taskId: workId, handoffId: handoff.id, trigger: handoff.trigger });
      sendJson(response, 201, { handoff });
      return;
    }
  }

  if (method === 'GET' && url.pathname === '/api/contracts') {
    sendJson(response, 200, {
      schemaVersion: CONTRACT_VERSION,
      contracts: {
        contextPack: {
          kind: 'team-loop-context-pack',
          requiredFields: ['packId', 'requiredInputs', 'readOrder', 'writeScope', 'forbiddenActions'],
          legacyAliases: { diId: 'packId', allowlist: 'writeScope' },
        },
        skillManifest: {
          requiredFields: ['skillType', 'automationLevel', 'humanApprovalPoints', 'sideEffectScope', 'requiredCapabilities'],
          skillTypes: ['procedural', 'assisted', 'executable'],
        },
        harness: {
          kind: 'team-loop-harness',
          requiredCheckFields: ['order', 'command', 'args', 'expectedExit', 'mutatesState'],
        },
        gateManifest: {
          kind: 'team-loop-gate-manifest',
          requiredCheckFields: ['order', 'harnessId', 'args', 'expectedExit', 'mutatesState'],
        },
        knowledgePromotion: KNOWLEDGE_PROMOTION_CONTRACT,
      },
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/workboard/export') {
    const snapshot = workboardEngine.createSnapshot({
      tasks: await store.listTasks(),
      users: await store.listUsers(),
      title: url.searchParams.get('title') || 'Team Loop Workboard',
      includeArchived: url.searchParams.get('archived') === 'true',
    });
    const content = renderStandaloneWorkboard(snapshot);
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(content),
      'Content-Disposition': 'attachment; filename="team-loop-workboard.html"',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(content);
    return;
  }

  const artifactDownloadMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/artifacts\/([^/]+)$/);
  if (method === 'GET' && artifactDownloadMatch) {
    const [, taskId, artifactId] = artifactDownloadMatch;
    const task = await store.getTask(taskId);
    if (!task) throw new HttpError(404, 'Task not found.');
    requireTaskParticipantOrAdmin(task, actor);
    const artifact = (task.artifacts || []).find((item) => item.id === artifactId);
    if (!artifact) throw new HttpError(404, 'Task artifact not found.');
    const content = await readFile(taskArtifactPath(taskId, artifactId));
    response.writeHead(200, {
      'Content-Type': artifact.contentType || 'application/octet-stream',
      'Content-Length': content.length,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(content);
    return;
  }

  if (method === 'GET' && url.pathname === '/api/ai-sessions') {
    sendJson(response, 200, { sessions: await aiSessionLogs.list({ limit: url.searchParams.get('limit') }) });
    return;
  }

  const aiSessionMatch = url.pathname.match(/^\/api\/ai-sessions\/([^/]+)$/);
  if (method === 'GET' && aiSessionMatch) {
    sendJson(response, 200, { session: await aiSessionLogs.get(decodeURIComponent(aiSessionMatch[1])) });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/bootstrap') {
    const [users, tasks, audits, profiles, harnesses, skills, failures, failureSummary, context, discussionSnapshot, runResults, activeRunScopes] = await Promise.all([
      store.listUsers(),
      store.listTasks(),
      store.listAuditEvents(),
      verifier.publicProfiles(),
      harnessRegistry.list(),
      skillRegistry.list(),
      failureCases.list({ limit: 500 }),
      failureCases.summary(),
      projectContext.get(),
      discussions.snapshot(),
      runDashboard.recent(),
      runScopes.list(),
    ]);
    const executorRouting = normalizeWorkerConfig(await loadConfig());
    sendJson(response, 200, {
      user: actor,
      users,
      tasks,
      workers: boardWorkerSnapshot(tasks),
      executorRouting,
      taskTimeline: buildTaskTimeline(tasks, audits),
      profiles,
      ai: ai.status(),
      usage: usageTracker.status(),
      harnesses,
      skills,
      failures,
      failureSummary,
      projectContext: context,
      contextIndex: contextIndex.status(),
      discussions: discussionSnapshot,
      runResults,
      activeRunScopes,
      workspace: { root: workspaceRoot },
      entry: await entryService.projectEntry('team-loop', tasks, audits),
      constitution: constitutionCompiler.status(),
      constitutionAudit: await constitutionObservations.audit(constitutionCompiler.status().constitutionVersion, { limit: 10 }),
      learningAudit: auditLearningArtifacts({ harnesses, skills }),
      idleVerification: idleVerifier.status(),
      turnBudget: await turnBudgetObservations.summary(),
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/project-context') {
    sendJson(response, 200, { projectContext: await projectContext.get() });
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

  if (method === 'POST' && url.pathname === '/api/experience/prepare') {
    const body = await readBody(request);
    assertPlainObject(body);
    if (!String(body.goal || body.title || '').trim()) throw new HttpError(400, 'Experience goal is required.');
    const pack = await experienceEngine.prepare(body);
    await store.recordAudit(actor.id, 'EXPERIENCE_PACK_PREPARED', {
      goalSha256: sha256(pack.goal),
      wikiEntries: pack.wiki.length,
      sourceCount: pack.sources.sourceCount,
      selectedHarnessId: pack.learning.selectedHarnessId,
      selectedSkillIds: pack.learning.selectedSkillIds,
    });
    sendJson(response, 200, { pack });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/context-packs/seeds') {
    sendJson(response, 200, { seeds: contextSeeds.list() });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/context-packs') {
    sendJson(response, 200, { packs: await contextPacks.list(actor.id, { limit: url.searchParams.get('limit') }) });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/context-packs/prepare') {
    const body = await readBody(request);
    assertPlainObject(body);
    const seed = contextSeeds.get(body.seedId);
    if (!seed) throw new HttpError(404, 'Context seed not found.');
    const budgetIncrease = ['maxSourceChunks', 'maxSourceCharacters', 'maxWikiEntries']
      .some((key) => body[key] != null && Number(body[key]) > seed[key]);
    const budgetRationale = String(body.budgetRationale || '').trim();
    if (budgetIncrease && !budgetRationale) {
      throw new HttpError(400, 'Increasing a context budget requires a rationale.');
    }
    const pack = await experienceEngine.prepare({
      ...body,
      maxWikiEntries: body.maxWikiEntries ?? seed.maxWikiEntries,
      maxSourceChunks: body.maxSourceChunks ?? seed.maxSourceChunks,
      maxSourceCharacters: body.maxSourceCharacters ?? seed.maxSourceCharacters,
      forbiddenActions: body.forbiddenActions ?? seed.forbiddenActions,
    });
    pack.layers = seed.layers;
    const record = await contextPacks.record(actor, seed, pack, budgetIncrease ? { rationale: budgetRationale } : null);
    await store.recordAudit(actor.id, 'CONTEXT_PACK_PREPARED', {
      contextPackId: record.id,
      packId: pack.contract.packId,
      seedId: seed.id,
      sourceCount: pack.sources.sourceCount,
      estimatedTokens: pack.sources.estimatedTokens,
      budgetIncreased: budgetIncrease,
      budgetRationale: budgetIncrease ? budgetRationale : null,
    });
    sendJson(response, 201, { record });
    return;
  }

  const contextPackMatch = url.pathname.match(/^\/api\/context-packs\/([^/]+)(?:\/(lock))?$/);
  if (contextPackMatch) {
    const [, contextPackId, action] = contextPackMatch;
    if (method === 'GET' && !action) {
      sendJson(response, 200, { record: await contextPacks.get(contextPackId, actor) });
      return;
    }
    if (method === 'POST' && action === 'lock') {
      const record = await contextPacks.lockPack(contextPackId, actor);
      await store.recordAudit(actor.id, 'CONTEXT_PACK_LOCKED', {
        contextPackId: record.id,
        packId: record.pack.contract.packId,
        receiptId: record.receipt.receiptId,
        estimatedTokens: record.receipt.budget.estimatedTokens,
      });
      sendJson(response, 200, { record });
      return;
    }
  }

  if (method === 'POST' && url.pathname === '/api/experience/reflect') {
    const body = await readBody(request);
    assertPlainObject(body);
    if (!String(body.goal || '').trim()) throw new HttpError(400, 'Reflection goal is required.');
    const experience = await experienceJournal.record(actor, body);
    const candidates = experienceEngine.reflectionCandidates(experience);
    const proposedWiki = [];
    for (const candidate of candidates.wikiCandidates) {
      const proposal = await wiki.propose(actor, { ...candidate, sourceExperienceId: experience.id });
      proposedWiki.push(proposal);
    }
    await store.recordAudit(actor.id, 'EXPERIENCE_REFLECTED', {
      experienceId: experience.id,
      verdict: experience.verdict,
      wikiCandidateIds: proposedWiki.map((item) => item.entry.id),
      failureCaseIds: experience.failureCaseIds,
    });
    sendJson(response, 201, {
      experience,
      candidates: { ...candidates, wikiCandidates: proposedWiki.map((item) => item.entry) },
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/experience/recent') {
    sendJson(response, 200, { experiences: await experienceJournal.recent({ limit: url.searchParams.get('limit') }) });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/wiki') {
    const query = url.searchParams.get('q');
    const entries = query
      ? await wiki.search(query, { includeCandidates: url.searchParams.get('candidates') === 'true', limit: url.searchParams.get('limit') })
      : await wiki.list({ status: url.searchParams.get('status') || undefined, limit: url.searchParams.get('limit') });
    sendJson(response, 200, { entries });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/wiki/propose') {
    const body = await readBody(request);
    assertPlainObject(body);
    const proposal = await wiki.propose(actor, body);
    await store.recordAudit(actor.id, proposal.duplicate ? 'WIKI_CANDIDATE_DUPLICATE' : 'WIKI_CANDIDATE_PROPOSED', {
      wikiEntryId: proposal.entry.id,
    });
    sendJson(response, proposal.duplicate ? 200 : 201, proposal);
    return;
  }

  const wikiStatusMatch = url.pathname.match(/^\/api\/wiki\/([^/]+)\/status$/);
  if (method === 'POST' && wikiStatusMatch) {
    requireAdmin(actor);
    const body = await readBody(request);
    assertPlainObject(body);
    const entry = await wiki.setStatus(wikiStatusMatch[1], actor.id, body.status);
    await store.recordAudit(actor.id, 'WIKI_STATUS_CHANGED', { wikiEntryId: entry.id, status: entry.status });
    sendJson(response, 200, { entry });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/context-index') {
    sendJson(response, 200, { contextIndex: contextIndex.status() });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/context-index/search') {
    sendJson(response, 200, contextIndex.search(url.searchParams.get('q') || '', {
      historical: url.searchParams.get('historical') === 'true',
      maxChunks: url.searchParams.get('maxChunks'),
      maxCharacters: url.searchParams.get('maxCharacters'),
    }));
    return;
  }

  if (method === 'POST' && url.pathname === '/api/context-index/refresh') {
    requireAdmin(actor);
    const status = await contextIndex.refresh();
    await store.recordAudit(actor.id, 'CONTEXT_INDEX_REFRESHED', status);
    sendJson(response, 200, { contextIndex: status });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/discussions/messages') {
    const body = await readBody(request);
    assertPlainObject(body);
    const message = await discussions.addMessage(actor, body);
    await store.recordAudit(actor.id, 'DISCUSSION_MESSAGE_CREATED', {
      messageId: message.id,
      length: message.content.length,
    });
    sendJson(response, 201, { message });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/discussions/ai-save') {
    const body = await readBody(request);
    assertPlainObject(body);
    const snapshot = await discussions.snapshot({ messageLimit: 200 });
    const selectedIds = new Set(Array.isArray(body.messageIds) ? body.messageIds.map(String) : []);
    const explicitSelection = selectedIds.size > 0;
    const memorizedMessageIds = new Set((snapshot.memories || []).flatMap((memory) => memory.sourceMessageIds || []));
    const selectedMessages = snapshot.messages.filter((message) =>
      explicitSelection ? selectedIds.has(message.id) : !memorizedMessageIds.has(message.id));
    const sourceMessageIds = selectedMessages.map((message) => message.id);
    if (!sourceMessageIds.length && !explicitSelection) {
      const latestMemory = [...(snapshot.memories || [])].reverse()[0] || null;
      sendJson(response, 200, { memory: latestMemory, duplicate: true });
      return;
    }
    const existingMemory = await discussions.findMemoryBySourceIds(sourceMessageIds);
    if (existingMemory) {
      sendJson(response, 200, { memory: existingMemory, duplicate: true });
      return;
    }
    const users = await store.listUsers();
    const userMap = new Map(users.map((user) => [user.id, user.name]));
    const context = await projectContext.get();
    let memoryDraft;
    let aiMeta = null;
    try {
      const contextPack = contextIndex.search(selectedMessages.map((message) => message.content).join('\n'));
      memoryDraft = await ai.discussionMemory({
        messages: selectedMessages.map((message) => ({ ...message, authorName: userMap.get(message.authorUserId) || '' })),
        projectContext: context,
        contextPack,
      });
      aiMeta = { provider: memoryDraft._meta?.provider || ai.status().provider, model: memoryDraft._meta?.model || ai.status().model, fallback: false };
    } catch (error) {
      if (error instanceof HttpError && ![503, 504].includes(error.status)) throw error;
      memoryDraft = fallbackDiscussionMemory(selectedMessages);
      aiMeta = { provider: ai.status().provider, model: ai.status().model, fallback: true, error: error.message };
    }
    const memory = await discussions.addMemory(actor, {
      ...memoryDraft,
      sourceMessageIds,
      ai: aiMeta,
    });
    await store.recordAudit(actor.id, 'DISCUSSION_MEMORY_SAVED', {
      memoryId: memory.id,
      sourceMessageCount: memory.sourceMessageIds.length,
      aiFallback: Boolean(aiMeta?.fallback),
    });
    sendJson(response, 201, { memory, duplicate: false });
    return;
  }


  if (method === 'GET' && url.pathname === '/api/usage') {
    const days = Number(url.searchParams.get('days') || 30);
    const allUsers = await store.listUsers();
    const visibleUsers = actor.role === 'admin' ? allUsers : allUsers.filter((user) => user.id === actor.id);
    const actorUserIds = visibleUsers.map((user) => user.id);
    const usage = await usageTracker.summary({ days, users: visibleUsers, actorUserIds });
    usage.scope.visibility = actor.role === 'admin' ? 'TEAM' : 'SELF';
    usage.scope.description = actor.role === 'admin'
      ? 'Team Loop 서버를 경유한 AI 요청을 팀 범위로 표시합니다.'
      : '현재 로그인한 사용자 본인의 Team Loop 서버 AI 요청만 표시합니다.';
    sendJson(response, 200, { usage });
    return;
  }

  if (url.pathname.startsWith('/api/balance/')) {
    await handleBalanceRoute({
      method, url, request, response, actor, readBody, sendJson, assertPlainObject,
      balanceExperiments, balancePortfolio, balanceJobs, balanceSeeds, auctionPlaySessions,
      audit: (...arguments_) => store.recordAudit(...arguments_),
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

  const harnessMatch = url.pathname.match(/^\/api\/harnesses\/([^/]+)(?:\/(update|test|activate|disable|archive))?$/);
  if (harnessMatch) {
    const [, harnessId, harnessAction] = harnessMatch;
    if (method === 'GET' && !harnessAction) {
      const harness = await harnessRegistry.get(harnessId);
      if (!harness) throw new HttpError(404, 'Harness not found.');
      sendJson(response, 200, { harness });
      return;
    }
    if (method === 'POST' && harnessAction) {
      const body = await readBody(request);
      assertPlainObject(body);
      if (harnessAction === 'test' || harnessAction === 'activate') {
        const harness = await harnessRegistry.get(harnessId);
        if (!harness) throw new HttpError(404, 'Harness not found.');
        requireAdminOrFailureDerivedOwner(actor, harness);
      } else {
        requireAdmin(actor);
      }
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
      const status = harnessAction === 'activate' ? 'ACTIVE' : harnessAction === 'archive' ? 'ARCHIVED' : 'DISABLED';
      const harness = await harnessRegistry.setStatus(harnessId, actor.id, body.expectedVersion, status);
      if (status === 'ACTIVE') await resolveArtifactCases(actor, harness, 'HARNESS');
      await store.recordAudit(actor.id, status === 'ACTIVE' ? 'HARNESS_ACTIVATED' : status === 'ARCHIVED' ? 'HARNESS_ARCHIVED' : 'HARNESS_DISABLED', { harnessId, version: harness.version });
      sendJson(response, 200, { harness });
      return;
    }
  }

  if (method === 'GET' && url.pathname === '/api/skills') {
    sendJson(response, 200, { skills: await skillRegistry.list() });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/learning/audit') {
    const [harnesses, skills] = await Promise.all([harnessRegistry.list(), skillRegistry.list()]);
    sendJson(response, 200, { audit: auditLearningArtifacts({ harnesses, skills }) });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/learning/audit/apply-cleanup') {
    requireAdmin(actor);
    const [harnesses, skills] = await Promise.all([harnessRegistry.list(), skillRegistry.list()]);
    const audit = auditLearningArtifacts({ harnesses, skills });
    const applied = [];
    for (const action of audit.actions) {
      if (action.type === 'HARNESS') {
        const current = await harnessRegistry.get(action.id);
        if (!current || current.status === 'ARCHIVED') continue;
        const harness = await harnessRegistry.setStatus(current.id, actor.id, current.version, 'ARCHIVED');
        applied.push({ ...action, status: harness.status });
        await store.recordAudit(actor.id, 'LEARNING_AUDIT_CLEANUP_APPLIED', action);
      } else if (action.type === 'SKILL') {
        const current = await skillRegistry.get(action.id);
        if (!current || current.status === 'ARCHIVED') continue;
        const skill = await skillRegistry.setStatus(current.id, actor.id, current.version, 'ARCHIVED');
        applied.push({ ...action, status: skill.status });
        await store.recordAudit(actor.id, 'LEARNING_AUDIT_CLEANUP_APPLIED', action);
      }
    }
    const [updatedHarnesses, updatedSkills] = await Promise.all([harnessRegistry.list(), skillRegistry.list()]);
    sendJson(response, 200, { applied, audit: auditLearningArtifacts({ harnesses: updatedHarnesses, skills: updatedSkills }) });
    return;
  }

  const skillMatch = url.pathname.match(/^\/api\/skills\/([^/]+)(?:\/(activate|disable|archive))?$/);
  if (skillMatch) {
    const [, skillId, skillAction] = skillMatch;
    if (method === 'GET' && !skillAction) {
      const skill = await skillRegistry.get(skillId);
      if (!skill) throw new HttpError(404, 'Skill not found.');
      sendJson(response, 200, { skill });
      return;
    }
    if (method === 'POST' && skillAction) {
      const body = await readBody(request);
      assertPlainObject(body);
      const current = await skillRegistry.get(skillId);
      if (!current) throw new HttpError(404, 'Skill not found.');
      if (skillAction === 'activate') requireAdminOrFailureDerivedOwner(actor, current);
      else requireAdmin(actor);
      const status = skillAction === 'activate' ? 'ACTIVE' : skillAction === 'archive' ? 'ARCHIVED' : 'DISABLED';
      const skill = await skillRegistry.setStatus(skillId, actor.id, body.expectedVersion, status);
      if (status === 'ACTIVE') await resolveArtifactCases(actor, skill, 'SKILL');
      await store.recordAudit(actor.id, status === 'ACTIVE' ? 'SKILL_ACTIVATED' : status === 'ARCHIVED' ? 'SKILL_ARCHIVED' : 'SKILL_DISABLED', { skillId, version: skill.version });
      sendJson(response, 200, { skill });
      return;
    }
  }

  if (method === 'POST' && url.pathname === '/api/learning/craft') {
    requireAdmin(actor);
    const body = await readBody(request);
    assertPlainObject(body);
    const result = await learning.craft(actor, body);
    if (result.type === 'SKILL' && result.skill?.status === 'DRAFT') {
      result.skill = await skillRegistry.setStatus(result.skill.id, actor.id, result.skill.version, 'ACTIVE');
      await resolveArtifactCases(actor, result.skill, 'SKILL');
    }
    await store.recordAudit(actor.id, 'FAILURE_LEARNING_CRAFTED', {
      type: result.type,
      harnessId: result.harness?.id ?? null,
      skillId: result.skill?.id ?? null,
      sourceFailureCaseIds: result.sourceFailureCases.map((item) => item.id),
    });
    sendJson(response, 201, result);
    return;
  }

  if (method === 'POST' && url.pathname === '/api/learning/auto-craft') {
    const body = await readBody(request);
    assertPlainObject(body);
    const cases = await selectedFailureCases(body.failureCaseIds);
    await requireAutoLearningAccess(actor, body.taskId, cases);
    const context = await projectContext.get();
    const plan = await planLearningArtifact({ cases, context });
    const crafted = await learning.craft(actor, { ...plan, failureCaseIds: cases.map((item) => item.id) });
    const result = await promotionEngine.activate(actor, crafted, plan);
    const artifact = result.skill || result.harness;
    if (result.promotion.status === 'PROBATION') await resolveArtifactCases(actor, artifact, result.type);
    await store.recordAudit(actor.id, 'LEARNING_ARTIFACT_AUTO_CRAFTED', {
      type: result.type,
      harnessId: result.harness?.id ?? null,
      skillId: result.skill?.id ?? null,
      sourceFailureCaseIds: result.sourceFailureCases.map((item) => item.id),
      planner: plan.planner,
      rationale: plan.rationale,
      promotionReceiptId: result.promotion.id,
      promotionStatus: result.promotion.status,
    });
    sendJson(response, 201, { ...result, plan });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/promotions') {
    const [candidates, receipts] = await Promise.all([
      promotionEngine.candidates(actor.id),
      promotionEngine.list(actor.id, { limit: url.searchParams.get('limit') }),
    ]);
    sendJson(response, 200, { policy: promotionEngine.status(), candidates, receipts });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/promotions/scan') {
    const candidates = await promotionEngine.candidates(actor.id);
    const context = await projectContext.get();
    const promotions = [];
    for (const candidate of candidates.filter((item) => item.score.verdict !== 'NOTE').slice(0, 10)) {
      try {
        const cases = await selectedFailureCases(candidate.failureCaseIds);
        // 기계가 판정할 수 없는 후보를 하네스나 스킬로 빚으려 하면 안 된다. 지식으로 남긴다.
        if (candidate.suggestedType === 'WIKI') {
          const filed = await promotionEngine.fileAsKnowledge(actor, candidate, cases);
          await store.recordAudit(actor.id, filed.duplicate ? 'WIKI_CANDIDATE_DUPLICATE' : 'WIKI_CANDIDATE_PROPOSED', {
            wikiEntryId: filed.entry.id,
            sourceFailureCaseIds: candidate.failureCaseIds,
            reason: 'UNDECIDABLE_BY_MACHINE',
          });
          promotions.push(filed);
          continue;
        }
        const plan = await planLearningArtifact({ cases, context });
        const crafted = await learning.craft(actor, { ...plan, failureCaseIds: candidate.failureCaseIds });
        const promoted = await promotionEngine.activate(actor, crafted, plan);
        const artifact = promoted.skill || promoted.harness;
        if (promoted.promotion.status === 'PROBATION') await resolveArtifactCases(actor, artifact, promoted.type);
        promotions.push(promoted);
      } catch (error) {
        promotions.push({ candidate, error: error.message });
      }
    }
    await store.recordAudit(actor.id, 'OPTIMISTIC_PROMOTION_SCAN_COMPLETED', {
      candidateCount: candidates.length,
      promotionCount: promotions.filter((item) => item.promotion).length,
    });
    sendJson(response, 200, {
      policy: promotionEngine.status(),
      promotions,
      candidates: await promotionEngine.candidates(actor.id),
      receipts: await promotionEngine.list(actor.id),
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/promotions/audit') {
    const changes = await promotionEngine.audit(actor);
    await store.recordAudit(actor.id, 'OPTIMISTIC_PROMOTION_AUDITED', { changes });
    sendJson(response, 200, {
      changes,
      candidates: await promotionEngine.candidates(actor.id),
      receipts: await promotionEngine.list(actor.id),
    });
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
    const contextPack = contextIndex.search(body.goal);
    const draft = await runTrackedAI(request, actor, 'task-draft', () => ai.draftTask({ goal: body.goal, tasks, profiles, projectContext: context, contextPack }), { contextPack });
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
    const contextPack = contextIndex.search(body.objective);
    const result = await runTrackedAI(request, actor, 'next-tasks', () => ai.suggestNextTasks({ objective: body.objective, tasks, profiles, projectContext: context, contextPack }), { contextPack });
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
    const contextPack = contextIndex.search(taskContextQuery(current));
    const generated = await runTrackedAI(
      request,
      actor,
      aiAction === 'brief' ? 'task-brief' : 'verification-summary',
      () => aiAction === 'brief'
        ? ai.taskBrief({ task: current, users, skills: appliedSkills, projectContext: context, contextPack })
        : ai.verificationSummary({ task: current, users, projectContext: context, contextPack }),
      { contextPack },
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
    body.assigneeUserId = actor.id;
    body.reviewerUserId = null;
    await validateAiProfiles(body);
    if (body.supersedesTaskId) {
      const original = await store.getTask(String(body.supersedesTaskId));
      if (!original) throw new HttpError(400, 'Superseded task not found.');
      if (original.archived) throw new HttpError(409, 'Superseded task is already archived.');
    }
    const profileNames = await verifier.profileNames();
    const explicitProfile = body.verificationProfile != null && String(body.verificationProfile).trim() !== '';
    const explicitSkills = Object.hasOwn(body, 'skillIds');
    const [activeHarnesses, activeSkills] = await Promise.all([
      harnessRegistry.list({ includeDisabled: false }),
      skillRegistry.list({ includeDisabled: false }),
    ]);
    const selectedLearning = selectLearningForTask(body, {
      activeHarnesses,
      activeSkills,
      defaultProfile: defaultVerificationProfile(profileNames),
    });
    if (explicitSkills) await skillRegistry.resolveActiveMany(body.skillIds ?? []);
    const task = await store.createTask(actor, body, profileNames, {
      defaultProfile: explicitProfile ? null : selectedLearning.verificationProfile,
      autoSkillIds: body.noAutoLearning || explicitSkills ? [] : selectedLearning.skillIds,
      autoLearningRationale: body.noAutoLearning || (explicitProfile && explicitSkills) ? null : selectedLearning.rationale,
    });
    sendJson(response, 201, { task });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/plans') {
    const tasks = await store.listTasks();
    const grouped = new Map();
    for (const task of tasks.filter((item) => item.planId)) {
      grouped.set(task.planId, [...(grouped.get(task.planId) || []), task]);
    }
    const plans = [...grouped]
      .map(([planId, planTasks]) => ({
        planId,
        title: planTasks[0]?.planTitle || 'Untitled plan',
        total: planTasks.length,
        completed: planTasks.filter((task) => task.status === 'DONE').length,
        blocked: planTasks.filter((task) => task.status === 'BLOCKED').length,
        tasks: planTasks,
      }));
    sendJson(response, 200, { plans });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/plans') {
    const body = await readBody(request);
    assertPlainObject(body);
    for (const step of Array.isArray(body.steps) ? body.steps : []) {
      step.assigneeUserId = actor.id;
      step.reviewerUserId = null;
      const profiles = await validateAiProfiles({
        ...body,
        ...step,
        executorProfileId: step.executorProfileId || body.executorProfileId,
        reviewerProfileId: step.reviewerProfileId || body.reviewerProfileId,
        approvalPolicy: step.approvalPolicy || body.approvalPolicy,
      });
      Object.assign(step, {
        executorProfileId: profiles.executorProfileId,
        reviewerProfileId: profiles.reviewerProfileId,
        approvalPolicy: profiles.approvalPolicy,
      });
    }
    const plan = await store.createPlan(actor, body, await verifier.profileNames());
    sendJson(response, 201, { plan });
    return;
  }

  const match = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(artifact|assign|queue-agent|cancel-agent|claim|files|submit|verify|request-review|ai-review|review-failure|review|block|unblock|recover-max-turns|archive|unarchive|schedule|activity|heartbeat|automation-result|delete)$/);
  if (!match || method !== 'POST') throw new HttpError(404, 'API route not found.');
  const [, taskId, action] = match;
  const body = await readBody(request, action === 'artifact' ? 12 * 1024 * 1024 : undefined);
  assertPlainObject(body);
  const expectedVersion = body.expectedVersion;

  if (action === 'artifact') {
    const current = await store.getTask(taskId);
    if (!current) throw new HttpError(404, 'Task not found.');
    requireAssigneeOrAdmin(current, actor);
    const name = safeArtifactName(body.name);
    const contentType = String(body.contentType || 'application/octet-stream').slice(0, 120);
    const encoded = String(body.data || '');
    if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new HttpError(400, 'Artifact data must be base64.');
    const content = Buffer.from(encoded, 'base64');
    if (!content.length) throw new HttpError(400, 'Artifact file is empty.');
    if (content.length > 8 * 1024 * 1024) throw new HttpError(413, 'Artifact file must be 8 MB or smaller.');
    const artifact = {
      id: randomId('art_'), name, contentType, size: content.length,
      uploadedAt: nowIso(), uploadedByUserId: actor.id,
    };
    const target = taskArtifactPath(taskId, artifact.id);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { flag: 'wx' });
    try {
      const task = await store.mutateTask(taskId, actor, expectedVersion, 'TASK_ARTIFACT_UPLOADED', async (next) => {
        requireAssigneeOrAdmin(next, actor);
        next.artifacts = [...(next.artifacts || []), artifact].slice(-20);
      });
      sendJson(response, 201, { task, artifact });
    } catch (error) {
      await unlink(target).catch(() => {});
      throw error;
    }
    return;
  }

  if (action === 'files') {
    const task = await store.getTask(taskId);
    if (!task) throw new HttpError(404, 'Task not found.');
    requireTaskParticipantOrAdmin(task, actor);
    sendJson(response, 200, await readRemoteTaskFiles(workspaceRoot, task, body.paths));
    return;
  }

  if (action === 'submit') {
    const current = await store.getTask(taskId);
    if (!current) throw new HttpError(404, 'Task not found.');
    requireAssigneeOrAdmin(current, actor);
    if (expectedVersion != null && Number(expectedVersion) !== current.version) throw new HttpError(409, 'Task version conflict. Refresh and retry.');
    const submission = await applyRemoteTaskSubmission(workspaceRoot, current, body);
    const task = await store.mutateTask(taskId, actor, current.version, 'TASK_REMOTE_RESULT_SUBMITTED', async (next) => {
      next.delivery = {
        type: 'MCP_FILES',
        submittedAt: nowIso(),
        submittedByUserId: actor.id,
        ...submission,
      };
      next.verification = null;
      next.executionMode = 'AGENT';
      next.executionState = 'IDLE';
    });
    sendJson(response, 200, { task, submission });
    return;
  }

  if (action === 'assign') {
    const current = await store.getTask(taskId);
    if (!current) throw new HttpError(404, 'Task not found.');
    requireTaskCreatorOrAdmin(current, actor);
    if (!['READY', 'BLOCKED'].includes(current.status)) {
      throw new HttpError(409, 'Assignee can only be changed while a task is READY or BLOCKED.');
    }
    const assigneeUserId = body.assigneeUserId || null;
    await validatePeople(assigneeUserId, current.reviewerUserId);
    const task = await store.mutateTask(taskId, actor, expectedVersion, 'TASK_ASSIGNEE_CHANGED', async (next) => {
      requireTaskCreatorOrAdmin(next, actor);
      if (!['READY', 'BLOCKED'].includes(next.status)) {
        throw new HttpError(409, 'Assignee can only be changed while a task is READY or BLOCKED.');
      }
      next.assigneeUserId = assigneeUserId;
      if (next.executionState === 'QUEUED') {
        next.executionMode = 'HUMAN';
        next.executionState = 'IDLE';
      }
    });
    sendJson(response, 200, { task });
    return;
  }

  if (action === 'schedule') {
    const task = await store.mutateTask(taskId, actor, expectedVersion, 'TASK_SCHEDULE_UPDATED', async (next) => {
      requireTaskParticipantOrAdmin(next, actor);
      next.schedule = normalizeTaskSchedule(body.schedule ?? body);
    });
    sendJson(response, 200, { task });
    return;
  }

  if (action === 'activity') {
    const task = await store.mutateTask(taskId, actor, null, 'TASK_AGENT_ACTIVITY_UPDATED', async (next) => {
      requireTaskParticipantOrAdmin(next, actor);
      next.agentActivity = normalizeAgentActivity(body.activity ?? body, actor);
    });
    sendJson(response, 200, { task });
    return;
  }

  if (action === 'heartbeat') {
    const task = await store.mutateTask(taskId, actor, null, 'TASK_AGENT_HEARTBEAT', async (next) => {
      requireAssigneeOrAdmin(next, actor);
      if (next.executionState !== 'RUNNING') throw new HttpError(409, 'Task is not running.');
      const at = nowIso();
      next.executionRun = {
        ...(next.executionRun || {}),
        status: 'RUNNING',
        heartbeatAt: at,
      };
      if (next.agentActivity) next.agentActivity.updatedAt = at;
    });
    sendJson(response, 200, { task, heartbeatAt: task.executionRun?.heartbeatAt });
    return;
  }

  if (action === 'automation-result') {
    const passed = body.passed === true;
    const signature = String(body.failureSignature || '').trim().slice(0, 500);
    const executionUsage = body.executionUsage && typeof body.executionUsage === 'object' ? body.executionUsage : {};
    const usage = executionUsage.usage && typeof executionUsage.usage === 'object' ? executionUsage.usage : {};
    const effectiveUsage = {
      ...usage,
      totalTokens: effectiveAutomationTokens(usage),
    };
    // 끝까지 돌아 성공을 보고한 실행에는 executorFailure가 없어 보고 문면이 어디에도 남지
    // 않았다. 실패 발췌와 같은 한도로 잘라 남겨야 주장 감사가 성공한 실행까지 본다.
    const retainedReport = retainExecutorReport(body.executorReport);
    const currentForBudget = await store.getTask(taskId);
    const task = await store.mutateTask(taskId, actor, null, 'TASK_AUTOMATION_RESULT_RECORDED', async (next) => {
      requireAssigneeOrAdmin(next, actor);
      if (retainedReport) next.executorReport = retainedReport;
      const result = recordAutomationResult(next.automationGuard, {
        passed,
        failureSignature: signature,
        at: nowIso(),
        usage: effectiveUsage,
        budget: {
          tokenBudget: currentForBudget?.delegation?.budget?.tokenBudget || process.env.AUTOMATION_TASK_TOKEN_BUDGET || 500_000,
          costBudgetUsd: currentForBudget?.delegation?.budget?.costBudgetUsd || process.env.AUTOMATION_TASK_COST_BUDGET_USD || 10,
        },
      });
      next.automationGuard = result.guard;
      if (result.guard.circuitOpen && !(passed && next.status === 'REVIEW')) {
        next.status = 'BLOCKED';
        next.executionState = 'IDLE';
        next.blocked = {
          reason: result.reason,
          byUserId: actor.id,
          at: nowIso(),
          automatic: true,
          failureSignature: signature,
        };
      }
    });
    // 턴 예산이 충분했는지는 지금 아무도 재지 않는다. 값을 고치기 전에 근거부터 쌓는다.
    // 관측 실패가 실행 기록을 막아서는 안 되므로 실패는 감사로만 남긴다.
    await turnBudgetObservations.record(task).catch((error) => {
      store.recordAudit(actor.id, 'TURN_BUDGET_OBSERVATION_FAILED', { taskId, error: String(error.message || error).slice(0, 300) }).catch(() => {});
    });
    if (body.executionUsage && typeof body.executionUsage === 'object') {
      await safeRecordUsage({
        actorUserId: actor.id,
        feature: 'task-executor',
        model: String(body.executionUsage.model || task.executor?.model || task.executor?.tool || 'unknown').slice(0, 120),
        source: 'cli',
        status: passed ? 'SUCCESS' : 'FAILED',
        durationMs: Math.max(0, Number(body.executionUsage.durationMs) || 0),
        usage: body.executionUsage.usage || {},
        error: passed ? null : signature,
        context: body.executionUsage.context || null,
      });
    }
    sendJson(response, 200, { task, circuitOpen: Boolean(task.automationGuard?.circuitOpen) });
    return;
  }

  if (action === 'queue-agent') {
    await requireCompletedDependencies(await store.getTask(taskId));
    const task = await store.mutateTask(taskId, actor, expectedVersion, 'TASK_AGENT_QUEUED', async (next) => {
      requireAssigneeOrAdmin(next, actor);
      if (next.status !== 'READY') throw new HttpError(409, 'Only READY tasks can enter the agent queue.');
      if (!next.assigneeUserId) throw new HttpError(409, 'Assign a human owner before queueing an agent.');
      next.executionMode = 'AGENT';
      next.executionState = 'QUEUED';
    });
    sendJson(response, 200, { task });
    return;
  }

  if (action === 'cancel-agent') {
    const task = await store.mutateTask(taskId, actor, expectedVersion, 'TASK_AGENT_QUEUE_CANCELLED', async (next) => {
      requireAssigneeOrAdmin(next, actor);
      if (next.status !== 'READY' || next.executionState !== 'QUEUED') throw new HttpError(409, 'Task is not waiting in the agent queue.');
      next.executionMode = 'HUMAN';
      next.executionState = 'IDLE';
    });
    sendJson(response, 200, { task });
    return;
  }

  if (action === 'claim') {
    await requireCompletedDependencies(await store.getTask(taskId));
    let executor;
    try {
      executor = sanitizeExecutorInput(body.executor, { actorUserId: actor.id, at: nowIso() });
    } catch (error) {
      throw new HttpError(error.statusCode || 400, error.message);
    }
    // Scope lock: refuse to start a task whose path scope overlaps an already-active task.
    const claiming = await store.getTask(taskId);
    if (claiming) await requireAvailableTaskScope(claiming);
    const task = await store.mutateTask(taskId, actor, expectedVersion, 'TASK_STARTED', async (next) => {
      if (next.status !== 'READY') throw new HttpError(409, 'Only READY tasks can be started.');
      if (next.assigneeUserId && next.assigneeUserId !== actor.id) throw new HttpError(403, 'This task is assigned to another user.');
      const mode = executionMode(body.executionMode, 'HUMAN');
      if (mode === 'AGENT' && next.executionState !== 'QUEUED') throw new HttpError(409, 'Agent execution requires a queued task.');
      next.assigneeUserId = actor.id;
      if (next.reviewerUserId === actor.id) next.reviewerUserId = null;
      next.status = 'IN_PROGRESS';
      next.blocked = null;
      next.review = null;
      next.executionMode = mode;
      next.executionState = mode === 'AGENT' ? 'RUNNING' : 'IDLE';
      next.executionRun = mode === 'AGENT' ? {
        id: randomId('run_'),
        status: 'RUNNING',
        startedAt: nowIso(),
        heartbeatAt: nowIso(),
        isolated: Boolean(body.isolated),
      } : null;
      if (executor) next.executor = executor;
    });
    sendJson(response, 200, { task });
    return;
  }

  if (action === 'verify') {
    const worktree = worktreePath(workspaceRoot, taskId);
    const verifyRoot = existsSync(worktree) ? worktree : workspaceRoot;
    await verifier.withWorkspaceLock(verifyRoot, async () => {
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
        verification = await verifier.runLocked(runningTask, verifyRoot);
        verification = applyAgentDeliveryGate(verification, runningTask, body.executionResult);
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
      verification.executor = runningTask.executor || null;

      const recordedFailures = verification.passed
        ? []
        : await failureCases.recordVerification({ task: runningTask, verification, actorUserId: actor.id });
      if (verification.passed) await failureCases.resolveTaskFailuresOnPass(taskId, verification.profile, actor.id);
      verification.failureCaseIds = recordedFailures.map((item) => item.id);
      const task = await saveVerificationResult(taskId, actor, runningTask.version, verification, {
        keepExecutionRunning: body.keepExecutionRunning === true,
      });
      const promotionChanges = await promotionEngine.audit(actor);
      const handoff = await entryService.writeHandoff(actor, 'team-loop', task, await store.listAuditEvents(), { trigger: 'VERIFICATION_COMPLETED' });
      sendJson(response, 200, { task, failureCases: recordedFailures, promotionChanges, handoff });
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
    if (!current.reviewerProfileId) throw new HttpError(409, 'Select a review AI profile before requesting review.');
    const task = await store.mutateTask(taskId, actor, expectedVersion, 'REVIEW_REQUESTED', async (next) => {
      if (!next.verification?.passed || !await verifier.fingerprintMatches(next.verification)) {
        throw new HttpError(409, 'Workspace changed after verification. Run verification again.');
      }
      next.status = 'REVIEW';
      next.executionState = 'IDLE';
      next.review = {
        status: 'PENDING',
        requestedAt: nowIso(),
        requestedByUserId: actor.id,
        reviewerProfileId: next.reviewerProfileId,
      };
    });
    const handoff = await entryService.writeHandoff(actor, 'team-loop', task, await store.listAuditEvents(), { trigger: 'REVIEW_REQUESTED' });
    sendJson(response, 200, { task, handoff });
    return;
  }

  if (action === 'ai-review') {
    const current = await store.getTask(taskId);
    if (!current) throw new HttpError(404, 'Task not found.');
    requireAssigneeOrAdmin(current, actor);
    if (current.status !== 'REVIEW') throw new HttpError(409, 'Task is not waiting for AI review.');
    const verdict = String(body.verdict || '').toUpperCase();
    if (!['APPROVE', 'REJECT'].includes(verdict)) throw new HttpError(400, 'AI review verdict must be APPROVE or REJECT.');
    if (!current.reviewerProfileId || String(body.reviewerProfileId || '') !== current.reviewerProfileId) {
      throw new HttpError(409, 'AI review profile does not match the task contract.');
    }
    const reviewUsage = normalizeReviewExecutionUsage(body.executionUsage, current);
    const task = await store.mutateTask(taskId, actor, expectedVersion, 'AI_REVIEW_RECORDED', async (next) => {
      next.aiReview = {
        status: 'COMPLETED',
        verdict,
        reviewerProfileId: next.reviewerProfileId,
        summary: String(body.summary || '').trim().slice(0, 4000),
        concerns: Array.isArray(body.concerns)
          ? body.concerns.map((item) => String(item).trim().slice(0, 1000)).filter(Boolean).slice(0, 20)
          : [],
        reviewedAt: nowIso(),
      };
      next.aiReviewBudget = accumulateReviewBudget(next.aiReviewBudget, reviewUsage);
    });
    await recordReviewUsage(actor, task, reviewUsage, 'SUCCESS');
    sendJson(response, 200, { task });
    return;
  }

  if (action === 'review-failure') {
    const current = await store.getTask(taskId);
    if (!current) throw new HttpError(404, 'Task not found.');
    requireAssigneeOrAdmin(current, actor);
    const kind = String(body.kind || '').trim().toUpperCase();
    const message = String(body.message || '').trim().slice(0, 4000);
    if (!kind || !message) throw new HttpError(400, 'Review failure kind and message are required.');
    const failure = await failureCases.recordProcessFailure({
      harnessId: 'ai-review-contract',
      kind,
      title: `AI review failed: ${message}`.slice(0, 500),
      taskIds: [current.id],
      identity: {
        stage: 'AI_REVIEW',
        reviewerProfileId: String(body.reviewerProfileId || current.reviewerProfileId || ''),
      },
      evidence: {
        message,
        taskStatus: current.status,
        taskVersion: current.version,
        reviewerProfileId: String(body.reviewerProfileId || current.reviewerProfileId || ''),
        exitCode: Number.isFinite(Number(body.exitCode)) ? Number(body.exitCode) : null,
        outputExcerpt: String(body.outputExcerpt || '').slice(0, 2000),
      },
    }, actor.id);
    const reviewUsage = normalizeReviewExecutionUsage(body.executionUsage, current);
    if (body.executionUsage) {
      await store.mutateTask(taskId, actor, current.version, 'AI_REVIEW_USAGE_RECORDED', async (next) => {
        next.aiReviewBudget = accumulateReviewBudget(next.aiReviewBudget, reviewUsage);
      });
      await recordReviewUsage(actor, current, reviewUsage, 'FAILED', kind);
    }
    await store.recordAudit(actor.id, 'AI_REVIEW_FAILED', {
      taskId: current.id,
      kind,
      failureCaseId: failure.id,
      occurrences: failure.occurrences,
      reviewerProfileId: String(body.reviewerProfileId || current.reviewerProfileId || ''),
      message,
    });
    const handoff = await entryService.writeHandoff(
      actor,
      'team-loop',
      current,
      await store.listAuditEvents(),
      {
        trigger: 'AI_REVIEW_FAILED',
        failedAttempts: [`${kind}: ${message}`],
        notes: `Failure case ${failure.id} recorded. Task remains in review.`,
      },
    );
    sendJson(response, 200, { failureCase: failure, handoff });
    return;
  }

  if (action === 'review') {
    const current = await store.getTask(taskId);
    if (!current) throw new HttpError(404, 'Task not found.');
    if (current.status !== 'REVIEW') throw new HttpError(409, 'Task is not waiting for review.');
    if (!canReviewTask(current, actor, { soloMode })) {
      if (actor.id === current.assigneeUserId) throw new HttpError(403, 'Assignees cannot review their own task.');
      throw new HttpError(403, 'This task has a different assigned reviewer.');
    }
    const decision = String(body.decision || '').toUpperCase();
    if (!['APPROVE', 'REJECT'].includes(decision)) throw new HttpError(400, 'Decision must be APPROVE or REJECT.');
    const alreadyMerged = decision === 'APPROVE' && await taskBranchMerged(workspaceRoot, taskId);
    let fingerprintMatches = true;
    if (decision === 'APPROVE' && !alreadyMerged) {
      try {
        fingerprintMatches = await verifier.fingerprintMatches(current.verification);
      } catch (error) {
        const delivery = await recordDeliveryFailure(current, actor, error, 'fingerprint');
        throw new HttpError(409, `Review remains pending because delivery failed: ${error.message}`, delivery);
      }
    }
    if (decision === 'APPROVE' && !alreadyMerged && !fingerprintMatches) {
      await store.mutateTask(taskId, actor, current.version, 'VERIFICATION_STALE', async (next) => {
        next.status = 'IN_PROGRESS';
        next.executionState = 'IDLE';
        next.review = null;
        next.verification = next.verification
          ? { ...next.verification, status: 'STALE', passed: false, staleAt: nowIso() }
          : null;
      });
      throw new HttpError(409, '검증 후 워크스페이스가 변경되었습니다. 작업 단계로 되돌렸으니 재검증 후 승인하세요.');
    }
    let merge = null;
    if (decision === 'APPROVE') {
      const wt = worktreePath(workspaceRoot, taskId);
      if (!existsSync(wt) && !alreadyMerged) {
        const error = new Error(`Task delivery worktree is missing: ${wt}`);
        const delivery = await recordDeliveryFailure(current, actor, error, 'merge');
        throw new HttpError(409, `Review remains pending because delivery failed: ${error.message}`, delivery);
      }
      if (existsSync(wt)) {
        try {
          const executorLabel = current.executor?.tool ? (current.executor.model ? `${current.executor.tool}/${current.executor.model}` : current.executor.tool) : null;
          merge = await mergeTaskWorktree(workspaceRoot, taskId, {
            message: current.title,
            trailers: { 'Team-Loop-Task': taskId, Executor: executorLabel, 'Reviewed-By': actor.name || actor.id },
          });
          await store.recordAudit(actor.id, 'TASK_MERGED', { taskId, commit: merge.commit, branch: merge.branch });
        } catch (error) {
          const delivery = await recordDeliveryFailure(current, actor, error, 'merge');
          throw new HttpError(409, `Review remains pending because delivery failed: ${error.message}`, delivery);
        }
      } else if (alreadyMerged) {
        merge = {
          merged: true,
          branch: `task/${taskId}`,
          commit: null,
          manuallyIntegrated: true,
        };
      }
    }
    const task = await store.mutateTask(taskId, actor, expectedVersion, decision === 'APPROVE' ? 'REVIEW_APPROVED' : 'REVIEW_REJECTED', async (next) => {
      next.review = {
        status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
        reviewerUserId: actor.id,
        reviewerProfileId: next.reviewerProfileId || null,
        comment: String(body.comment ?? '').trim().slice(0, 2000),
        reviewedAt: nowIso(),
        solo: soloMode && actor.id === next.assigneeUserId,
        adminOverride: actor.role === 'admin' && (actor.id === next.assigneeUserId || (next.reviewerUserId && next.reviewerUserId !== actor.id)),
      };
      if (decision === 'APPROVE') {
        const completedAt = nowIso();
        next.status = 'DONE';
        next.executionState = 'IDLE';
        next.completedAt = completedAt;
        next.archived = true;
        next.archivedAt = completedAt;
        next.archivedByUserId = actor.id;
      } else {
        next.status = 'IN_PROGRESS';
        next.executionState = 'IDLE';
        next.verification = next.verification
          ? { ...next.verification, status: 'STALE', passed: false, staleAt: nowIso() }
          : null;
      }
    });
    if (decision === 'APPROVE' && task.status === 'DONE') {
      await store.finalizeSupersession(task, actor);
      await failureCases.resolveTaskProcessFailures(
        taskId,
        'delivery-integrity',
        actor.id,
        `Resolved by successful task delivery and approval for ${taskId}.`,
      );
    }
    if (decision === 'APPROVE' && merge?.merged) {
      try {
        const refreshed = await contextIndex.refresh();
        await store.recordAudit(actor.id, 'CONTEXT_INDEX_AUTO_REFRESHED', { taskId, ...refreshed });
      } catch (error) {
        await store.recordAudit(actor.id, 'CONTEXT_INDEX_AUTO_REFRESH_FAILED', { taskId, error: error.message }).catch(() => {});
      }
    }
    const handoff = await entryService.writeHandoff(actor, 'team-loop', task, await store.listAuditEvents(), { trigger: decision === 'APPROVE' ? 'WORK_COMPLETED' : 'REVIEW_REJECTED' });
    const planProgression = decision === 'APPROVE'
      ? await progressAfterApproval(task, actor)
      : { decision: 'NONE', reason: 'REVIEW_REJECTED', task: null, worker: null };
    sendJson(response, 200, { task, merge, handoff, autoArchived: decision === 'APPROVE', planProgression });
    return;
  }

  if (action === 'block') {
    const reason = String(body.reason ?? '').trim();
    if (!reason) throw new HttpError(400, 'Block reason is required.');
    const task = await store.mutateTask(taskId, actor, expectedVersion, 'TASK_BLOCKED', async (next) => {
      requireTaskParticipantOrAdmin(next, actor);
      if (next.status === 'DONE') throw new HttpError(409, 'Completed tasks cannot be blocked.');
      next.status = 'BLOCKED';
      next.executionState = 'IDLE';
      next.blocked = { reason: reason.slice(0, 2000), byUserId: actor.id, at: nowIso() };
    });
    const handoff = await entryService.writeHandoff(actor, 'team-loop', task, await store.listAuditEvents(), { trigger: 'WORK_BLOCKED' });
    sendJson(response, 200, { task, handoff });
    return;
  }

  if (action === 'unblock') {
    const task = await store.mutateTask(taskId, actor, expectedVersion, 'TASK_UNBLOCKED', async (next) => {
      requireTaskParticipantOrAdmin(next, actor);
      if (next.status !== 'BLOCKED') throw new HttpError(409, 'Task is not blocked.');
      const resumeReview = Boolean(next.verification?.passed && next.review?.status === 'PENDING');
      next.status = resumeReview ? 'REVIEW' : 'READY';
      next.blocked = null;
      if (!resumeReview) {
        next.verification = null;
        next.review = null;
      }
      next.automationGuard = {
        ...(next.automationGuard || {}),
        failedRuns: 0,
        sameFailureCount: 0,
        lastFailureSignature: '',
        circuitOpen: false,
        resetAt: nowIso(),
      };
      next.executionMode = 'HUMAN';
      next.executionState = 'IDLE';
    });
    sendJson(response, 200, { task });
    return;
  }

  if (action === 'recover-max-turns') {
    const current = await store.getTask(taskId);
    requireTaskParticipantOrAdmin(current, actor);
    sendJson(response, 200, await decomposeMaxTurnTask(current, actor));
    return;
  }

  if (action === 'archive' || action === 'unarchive') {
    if (action === 'archive' && await worktreeHasChanges(workspaceRoot, taskId)) {
      throw new HttpError(409, 'Archive blocked: this task still has unlanded worktree changes.');
    }
    const task = await store.mutateTask(taskId, actor, expectedVersion, action === 'archive' ? 'TASK_ARCHIVED' : 'TASK_UNARCHIVED', async (next) => {
      requireTaskParticipantOrAdmin(next, actor);
      if (action === 'archive') {
        if (next.status !== 'DONE') throw new HttpError(409, 'Only DONE tasks can be archived.');
        next.archived = true;
        next.archivedAt = nowIso();
        next.archivedByUserId = actor.id;
      } else {
        next.archived = false;
        next.archivedAt = null;
        next.archivedByUserId = null;
      }
    });
    sendJson(response, 200, { task });
  }

  if (action === 'delete') {
    // 삭제된 태스크의 worktree를 남기면 디스크에 고아가 쌓이고, 그 존재가 유휴 판정을 오염시킨다.
    // 다만 착지하지 않은 작업을 조용히 파괴하지는 않는다 — archive와 같은 가드를 쓴다.
    if (await worktreeHasChanges(workspaceRoot, taskId)) {
      throw new HttpError(409, 'Delete blocked: this task still has unlanded worktree changes.');
    }
    const result = await store.deleteTask(taskId, actor, expectedVersion);
    // 없던 worktree를 지우려다 실패했다고 보고하면 그건 오보다. 있을 때만 시도한다.
    const worktree = existsSync(worktreePath(workspaceRoot, taskId))
      ? await removeTaskWorktree(workspaceRoot, taskId)
        .then(() => ({ removed: true, error: null }))
        .catch((error) => ({ removed: false, error: String(error.message || error).slice(0, 300) }))
      : { removed: false, error: null, absent: true };
    if (!worktree.removed && !worktree.absent) {
      // 정리 실패를 조용히 삼키지 않는다.
      await store.recordAudit(actor.id, 'TASK_WORKTREE_CLEANUP_FAILED', { taskId, error: worktree.error }).catch(() => {});
    }
    sendJson(response, 200, { ...result, worktree });
  }
}

function normalizeReviewExecutionUsage(value, task) {
  const input = value && typeof value === 'object' ? value : {};
  const usage = input.usage && typeof input.usage === 'object' ? input.usage : {};
  const context = input.context && typeof input.context === 'object' ? input.context : {};
  const budget = input.budget && typeof input.budget === 'object' ? input.budget : {};
  return {
    model: String(input.model || task.reviewerProfileId || 'unknown').slice(0, 120),
    durationMs: Math.max(0, Number(input.durationMs) || 0),
    usage,
    effectiveTokens: effectiveAutomationTokens(usage),
    costUsd: Math.max(0, Number(usage.costUsd) || 0),
    context: {
      profileId: String(context.profileId || task.reviewerProfileId || '').slice(0, 80),
      selectedTokens: Math.max(0, Number(context.selectedTokens) || 0),
      maxTurns: Math.max(1, Number(context.maxTurns) || 8),
      stage: 'AI_REVIEW',
    },
    budget: {
      tokenBudget: Math.max(1_000, Number(budget.tokenBudget) || 100_000),
      costBudgetUsd: Math.max(0.01, Number(budget.costBudgetUsd) || 2),
    },
  };
}

function accumulateReviewBudget(previous = {}, execution) {
  return {
    tokenBudget: execution.budget.tokenBudget,
    costBudgetUsd: execution.budget.costBudgetUsd,
    cumulativeTokens: Math.max(0, Number(previous.cumulativeTokens) || 0) + execution.effectiveTokens,
    cumulativeCostUsd: Math.round((Math.max(0, Number(previous.cumulativeCostUsd) || 0) + execution.costUsd) * 1_000_000) / 1_000_000,
    lastRunAt: nowIso(),
    profileId: execution.context.profileId,
    contextTokens: execution.context.selectedTokens,
    maxTurns: execution.context.maxTurns,
  };
}

async function recordReviewUsage(actor, task, execution, status, error = null) {
  await safeRecordUsage({
    actorUserId: actor.id,
    feature: 'ai-review',
    model: execution.model,
    source: 'cli',
    status,
    durationMs: execution.durationMs,
    usage: execution.usage,
    error,
    context: {
      ...execution.context,
      taskId: task.id,
      reviewerProfileId: task.reviewerProfileId,
    },
  });
}

async function runTrackedAI(request, actor, feature, work, { contextPack = null } = {}) {
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
      context: contextUsage(contextPack),
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
      context: contextUsage(contextPack),
    });
    throw error;
  }
}

function contextUsage(contextPack) {
  if (!contextPack) return null;
  return {
    selectedTokens: contextPack.estimatedTokens,
    sourceCount: contextPack.sourceCount,
    indexedTokens: contextIndex.status().estimatedTokens,
  };
}


async function recordDeliveryFailure(task, actor, error, phase) {
  const classified = classifyDeliveryFailure(error, { phase });
  const failure = await failureCases.recordProcessFailure({
    ...classified,
    taskIds: [task.id],
    evidence: {
      ...classified.evidence,
      taskStatus: task.status,
      taskVersion: task.version,
      verificationStatus: task.verification?.status || null,
      verificationFingerprint: task.verification?.workspaceFingerprint || null,
    },
  }, actor.id);
  await store.recordAudit(actor.id, 'TASK_MERGE_FAILED', {
    taskId: task.id,
    phase,
    kind: failure.kind,
    failureCaseId: failure.id,
    occurrences: failure.occurrences,
    error: String(error?.message || error),
  });
  const handoff = await entryService.writeHandoff(
    actor,
    'team-loop',
    task,
    await store.listAuditEvents(),
    {
      trigger: 'DELIVERY_FAILED',
      failedAttempts: [`${failure.kind}: ${failure.title}`],
      notes: `Failure case ${failure.id} recorded. Approval remains pending until delivery succeeds.`,
    },
  );
  return { failureCase: failure, handoff };
}


async function saveVerificationResult(taskId, actor, expectedVersion, verification, { keepExecutionRunning = false } = {}) {
  try {
    return await store.mutateTask(taskId, actor, expectedVersion, 'VERIFICATION_FINISHED', async (next) => {
      next.verification = verification;
      next.executionState = keepExecutionRunning ? 'RUNNING' : 'IDLE';
      next.executionRun = next.executionRun ? {
        ...next.executionRun,
        status: keepExecutionRunning ? 'RUNNING' : verification.passed ? 'VERIFIED' : 'VERIFICATION_FAILED',
        finishedAt: keepExecutionRunning ? null : nowIso(),
      } : null;
    });
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 409) throw error;
  }

  const latest = await store.getTask(taskId);
  if (!latest) throw new HttpError(404, 'Task not found while recording verification.');
  try {
    return await store.mutateTask(taskId, actor, latest.version, 'VERIFICATION_FINISHED_AFTER_CONFLICT', async (next) => {
      next.verification = verification;
      next.executionState = keepExecutionRunning ? 'RUNNING' : 'IDLE';
      next.executionRun = next.executionRun ? {
        ...next.executionRun,
        status: keepExecutionRunning ? 'RUNNING' : verification.passed ? 'VERIFIED' : 'VERIFICATION_FAILED',
        finishedAt: keepExecutionRunning ? null : nowIso(),
      } : null;
    });
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 409) throw error;
  }

  const finalCurrent = await store.getTask(taskId);
  if (!finalCurrent) throw new HttpError(404, 'Task not found while recording verification error.');
  return store.mutateTask(taskId, actor, finalCurrent.version, 'VERIFICATION_RESULT_RECORDING_FAILED', async (next) => {
    next.executionState = 'IDLE';
    next.executionRun = next.executionRun ? {
      ...next.executionRun,
      status: 'RESULT_RECORDING_FAILED',
      finishedAt: nowIso(),
    } : null;
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
  const userIds = new Set(users.filter((user) => user.active).map((user) => user.id));
  if (assigneeUserId && !userIds.has(assigneeUserId)) throw new HttpError(400, 'Assignee not found.');
  if (reviewerUserId && !userIds.has(reviewerUserId)) throw new HttpError(400, 'Reviewer not found.');
  if (assigneeUserId && reviewerUserId && assigneeUserId === reviewerUserId) {
    throw new HttpError(400, 'Reviewer must differ from assignee.');
  }
}

async function selectedFailureCases(ids) {
  const failureCaseIds = [...new Set((Array.isArray(ids) ? ids : [])
    .map((item) => String(item).trim()).filter(Boolean))];
  if (failureCaseIds.length === 0 || failureCaseIds.length > 50) throw new HttpError(400, 'Select 1-50 cases.');
  const cases = [];
  for (const id of failureCaseIds) {
    const item = await failureCases.get(id);
    if (!item) throw new HttpError(404, `Case not found: ${id}`);
    cases.push(item);
  }
  return cases;
}

async function resolveArtifactCases(actor, artifact, type) {
  const ids = [...new Set((artifact.sourceFailureCaseIds || []).map((item) => String(item).trim()).filter(Boolean))];
  for (const id of ids) {
    const current = await failureCases.get(id);
    if (!current || current.status === 'RESOLVED' || current.status === 'IGNORED') continue;
    await failureCases.setStatus(
      id,
      actor.id,
      'RESOLVED',
      `${type} ${artifact.id} activated; case archived until the same signature reappears.`,
    );
    await store.recordAudit(actor.id, 'CASE_ARCHIVED_BY_ARTIFACT', { failureId: id, type, artifactId: artifact.id });
  }
}

async function planLearningArtifact({ cases, context }) {
  let plan = null;
  if (ai.status().enabled) {
    try {
      const contextPack = contextIndex.search(cases.map((item) => [item.title, item.kind, item.harnessId, item.lastEvidence?.file].filter(Boolean).join(' ')).join('\n'));
      plan = await ai.learningArtifactPlan({ failureCases: cases, projectContext: context, contextPack });
    } catch (error) {
      console.error('AI learning artifact planning failed; falling back:', error.message);
    }
  }
  const fallback = fallbackLearningPlan(cases);
  const source = plan?.type ? plan : fallback;
  return {
    type: source.type === 'HARNESS' && casesContainCommands(cases) ? 'HARNESS' : source.type === 'SKILL' ? 'SKILL' : fallback.type,
    id: stableArtifactId(source.id || fallback.id, cases),
    label: String(source.label || fallback.label).trim().slice(0, 120),
    description: String(source.description || fallback.description).trim().slice(0, 2000),
    rules: Array.isArray(source.rules) ? source.rules : fallback.rules,
    rationale: source.rationale || fallback.rationale,
    planner: plan?.type ? 'ai' : 'fallback',
  };
}

function taskContextQuery(task = {}) {
  return [
    task.title,
    task.description,
    ...(task.allowedPaths || []),
    ...(task.acceptanceCriteria || []),
    task.verificationProfile,
  ].filter(Boolean).join('\n');
}

function fallbackLearningPlan(cases) {
  const harness = casesContainCommands(cases);
  const kinds = [...new Set(cases.map((item) => item.kind).filter(Boolean))].join('-').toLowerCase() || 'case';
  return {
    type: harness ? 'HARNESS' : 'SKILL',
    id: harness ? `regression-${kinds}` : `skill-${kinds}`,
    label: harness ? `Regression check: ${kinds}` : `Rule: ${kinds}`,
    description: harness
      ? `Draft regression harness from ${cases.length} selected case(s).`
      : `Draft skill rules from ${cases.length} selected case(s).`,
    rules: harness ? [] : cases.map(ruleFromCase).filter(Boolean),
    rationale: harness
      ? 'Selected cases include executable command evidence, so a rerunnable harness is appropriate.'
      : 'Selected cases do not contain rerunnable command evidence, so procedural skill guidance is safer.',
  };
}

function casesContainCommands(cases) {
  return cases.some((item) => String(item?.lastEvidence?.file || '').trim());
}

function ruleFromCase(item) {
  if (item.kind === 'SCOPE_VIOLATION') return `allowedPaths 밖의 \`${item.lastEvidence?.path || item.title}\` 경로를 수정하지 않는다.`;
  return `\`${item.title || item.id}\` 사례가 반복되지 않도록 완료 전에 관련 검증과 변경 범위를 확인한다.`;
}

function stableArtifactId(value, cases) {
  const slug = String(value || 'learned-artifact')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    || 'learned-artifact';
  const suffix = sha256(cases.map((item) => item.id).sort().join('|')).slice(0, 8);
  return `${slug.slice(0, 55)}-${suffix}`.replace(/^-+/, 'a');
}

function defaultVerificationProfile(profileNames) {
  if (profileNames.includes('repository-basic')) return 'repository-basic';
  return profileNames[0] ?? null;
}

function requireAdmin(actor) {
  if (actor.role !== 'admin') throw new HttpError(403, 'Administrator access is required.');
}

function requireAdminOrFailureDerivedOwner(actor, artifact) {
  if (actor.role === 'admin') return;
  if (artifact?.source === 'FAILURE_DERIVED' && artifact.createdByUserId === actor.id) return;
  throw new HttpError(403, 'Administrator access or failure-derived artifact ownership is required.');
}

async function requireAutoLearningAccess(actor, taskId, cases) {
  if (actor.role === 'admin') return;
  const normalizedTaskId = String(taskId ?? '').trim();
  if (!normalizedTaskId) throw new HttpError(400, 'taskId is required for member auto-learning.');
  const task = await store.getTask(normalizedTaskId);
  if (!task) throw new HttpError(404, 'Task not found.');
  requireAssigneeOrAdmin(task, actor);
  if (task.status !== 'IN_PROGRESS') throw new HttpError(409, 'Auto-learning requires an IN_PROGRESS task.');
  const unrelated = cases.filter((item) => !(item.taskIds || []).includes(task.id));
  if (unrelated.length) {
    throw new HttpError(403, 'Members can auto-learn only from failure cases produced by their assigned task.');
  }
}

function requireAssigneeOrAdmin(task, actor) {
  if (task.assigneeUserId !== actor.id && actor.role !== 'admin') throw new HttpError(403, 'Only the assignee can do this.');
}

function requireTaskParticipantOrAdmin(task, actor) {
  if (!task) throw new HttpError(404, 'Task not found.');
  if (![task.creatorUserId, task.assigneeUserId, task.reviewerUserId].includes(actor.id) && actor.role !== 'admin') {
    throw new HttpError(403, 'Only a task participant can do this.');
  }
}

async function validateAiProfiles(body) {
  const config = await loadConfig();
  const execution = selectExecutor(body, config, { executorId: String(body.executorProfileId || '') });
  if (!execution.candidate) throw new HttpError(400, 'Select an available execution AI profile.');
  const review = selectReviewer(body, config, {
    reviewerProfileId: String(body.reviewerProfileId || ''),
    executorProfileId: execution.candidate.id,
  });
  if (!review.candidate) throw new HttpError(400, 'Select an available review AI profile.');
  body.executorProfileId = execution.candidate.id;
  body.reviewerProfileId = review.candidate.id;
  body.approvalPolicy = normalizeApprovalPolicy(body.approvalPolicy);
  return body;
}

async function streamWorkEvents(request, response, actor) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.write('retry: 2000\n\n');
  let previous = '';
  let closed = false;
  let reading = false;
  const publish = async (initial = false) => {
    if (closed || reading) return;
    reading = true;
    try {
      const tasks = await store.listTasks();
      const payload = {
        initial,
        at: nowIso(),
        userId: actor.id,
        tasks: tasks.map(workEventTask),
        workers: boardWorkerSnapshot(tasks),
      };
      const signature = JSON.stringify({ tasks: payload.tasks, workers: payload.workers });
      if (initial || signature !== previous) {
        previous = signature;
        response.write(`event: work\ndata: ${JSON.stringify(payload)}\n\n`);
      } else {
        response.write(`: heartbeat ${Date.now()}\n\n`);
      }
    } catch (error) {
      response.write(`event: warning\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
    } finally {
      reading = false;
    }
  };
  await publish(true);
  const interval = setInterval(() => publish(false), 1_000);
  request.on('close', () => {
    closed = true;
    clearInterval(interval);
  });
}

function workEventTask(task) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    archived: Boolean(task.archived),
    executionState: task.executionState,
    updatedAt: task.updatedAt,
    verification: task.verification ? {
      status: task.verification.status,
      passed: Boolean(task.verification.passed),
      finishedAt: task.verification.finishedAt || null,
    } : null,
    activity: task.agentActivity ? {
      phase: task.agentActivity.phase,
      label: task.agentActivity.label,
      updatedAt: task.agentActivity.updatedAt,
      finishedAt: task.agentActivity.finishedAt,
    } : null,
    blockedReason: task.blocked?.reason || '',
  };
}

async function decomposeMaxTurnTask(task, actor) {
  if (!task) throw new HttpError(404, 'Task not found.');
  if (task.recovery?.childTaskIds?.length) {
    if (!task.archived || task.status === 'BLOCKED') {
      task = await store.mutateTask(task.id, actor, task.version, 'MAX_TURNS_RECOVERY_PARENT_COLLAPSED', async (next) => {
        next.status = 'IN_PROGRESS';
        next.blocked = null;
        next.archived = true;
        next.archivedAt = nowIso();
        next.archivedByUserId = actor.id;
      });
    }
    const tasks = await store.listTasks();
    const childTaskIds = task.recovery.childTaskIds;
    const partial = childTaskIds
      .map((id) => tasks.find((item) => item.id === id))
      .find((item) => isRecoverablePartialMaxTurnFailure(item));
    if (partial) {
      await queuePartialMaxTurnRecovery(partial, actor);
      return { outcome: 'RESUMED_PARTIAL', task, childTaskIds, resumedTaskId: partial.id };
    }
    const candidate = childTaskIds
      .map((id) => tasks.find((item) => item.id === id))
      .find((item) => item?.status === 'READY'
        && item.executionState !== 'RUNNING'
        && (item.dependsOnTaskIds || []).every((id) => tasks.find((dependency) => dependency.id === id)?.status === 'DONE'));
    const resumed = candidate ? await startRecoveryTask(candidate, actor) : null;
    return { outcome: resumed ? 'RESUMED' : 'EXISTING', task, childTaskIds, resumed };
  }
  if (!isExhaustedMaxTurnFailure(task)) throw new HttpError(409, 'Task is not an exhausted maximum-turn failure.');
  const definition = buildMaxTurnRecoveryPlan(task);
  if (!definition) return handleTerminalMaxTurnTask(task, actor);
  const plan = await store.createPlan(actor, definition, await verifier.profileNames());
  const childTaskIds = plan.tasks.map((item) => item.id);
  const parent = await store.mutateTask(task.id, actor, task.version, 'MAX_TURNS_TASK_DECOMPOSED', async (next) => {
    next.status = 'IN_PROGRESS';
    next.executionState = 'IDLE';
    next.blocked = null;
    next.recovery = { reason: 'MAX_TURNS_RECOVERY_EXHAUSTED', planId: plan.planId, childTaskIds, depth: Number(task.recovery?.depth || 0), createdAt: nowIso() };
    next.archived = true;
    next.archivedAt = nowIso();
    next.archivedByUserId = actor.id;
  });
  await store.recordAudit(actor.id, 'MAX_TURNS_RECOVERY_PLAN_CREATED', { taskId: task.id, planId: plan.planId, childTaskIds });
  const first = await startRecoveryTask(plan.tasks[0], actor);
  return { outcome: 'DECOMPOSED', task: parent, plan, first };
}

async function startRecoveryTask(task, actor) {
  const config = await loadConfig();
  const execution = selectExecutor(task, config, { executorId: task.executorProfileId || '' });
  const review = selectReviewer(task, config, { reviewerProfileId: task.reviewerProfileId || '', executorProfileId: execution.candidate?.id || '' });
  if (!execution.candidate || !review.candidate) throw new Error('No eligible recovery execution or review profile.');
  const queued = await store.mutateTask(task.id, actor, task.version, 'RECOVERY_CHILD_AUTO_QUEUED', async (next) => {
    next.assigneeUserId = actor.id;
    next.executorProfileId = execution.candidate.id;
    next.reviewerProfileId = review.candidate.id;
    next.approvalPolicy = 'AUTO';
    next.executionMode = 'AGENT';
    next.executionState = 'QUEUED';
    next.executor = sanitizeExecutorInput(execution.executor, { actorUserId: actor.id, at: nowIso() });
  });
  const worker = launchBoardWorker(queued, actor, serviceSessionCookie(actor.id), { executorId: queued.executorProfileId, reviewerProfileId: queued.reviewerProfileId });
  return { task: queued, worker };
}

async function handleTerminalMaxTurnTask(task, actor) {
  const decision = terminalMaxTurnDecision(task);
  if (decision.action === 'ESCALATE_ONCE') {
    const queued = await store.mutateTask(task.id, actor, task.version, 'MAX_TURNS_TERMINAL_RETRY_QUEUED', async (next) => {
      next.status = 'IN_PROGRESS';
      next.executionState = 'RUNNING';
      next.blocked = null;
      next.agentActivity = normalizeAgentActivity({
        ...(next.agentActivity || {}),
        phase: 'terminal-recovery',
        label: '최종 자동 복구 실행',
        detail: `더 분해할 수 없어 턴 한도를 ${decision.maxTurns}회로 높여 마지막 자동 복구를 실행합니다.`,
        attempt: 1,
        maxAttempts: 1,
        finished: false,
      }, actor);
    });
    const worker = launchBoardWorker(queued, actor, serviceSessionCookie(actor.id), {
      executorId: queued.executorProfileId,
      reviewerProfileId: queued.reviewerProfileId,
      maxTurns: decision.maxTurns,
      retry: 1,
    });
    await store.recordAudit(actor.id, 'MAX_TURNS_TERMINAL_RETRY_STARTED', {
      taskId: task.id,
      maxTurns: decision.maxTurns,
      workerPid: worker.pid,
    });
    return { outcome: 'TERMINAL_RETRY', task: queued, worker, maxTurns: decision.maxTurns };
  }

  const failure = await failureCases.recordProcessFailure({
    harnessId: 'workflow-integrity',
    kind: 'LOOP_STALLED_MAX_TURN_DEPTH',
    title: 'Autonomous loop exhausted maximum recovery depth',
    taskIds: [task.id, task.delegation?.parentTaskId].filter(Boolean),
    identity: {
      stage: 'AUTOMATIC_RECOVERY',
      cause: 'MAX_TURN_DEPTH_EXHAUSTED',
      rootTaskId: task.delegation?.rootTaskId || task.id,
    },
    evidence: {
      taskId: task.id,
      depth: task.delegation?.depth || 0,
      totalRuns: task.automationGuard?.totalRuns || 0,
      changedPaths: task.verification?.changedPaths || [],
      circuitOpen: Boolean(task.automationGuard?.circuitOpen),
      budgetExceeded: Boolean(task.automationGuard?.budgetExceeded),
    },
  }, actor.id);
  const blocked = await blockRecoveryChain(task, actor, failure.id);
  return { outcome: 'BLOCKED_CRITICAL', task: blocked, failureCaseId: failure.id };
}

async function blockRecoveryChain(task, actor, failureCaseId) {
  let current = task;
  let leaf = task;
  const visited = new Set();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const updated = await store.mutateTask(current.id, actor, current.version, 'LOOP_STALLED_CRITICAL', async (next) => {
      next.status = 'BLOCKED';
      next.executionState = 'IDLE';
      next.archived = false;
      next.archivedAt = null;
      next.archivedByUserId = null;
      next.blocked = {
        reason: `Critical autonomous-loop stall after maximum recovery depth. Failure: ${failureCaseId}`,
        byUserId: actor.id,
        at: nowIso(),
        automatic: true,
        severity: 'CRITICAL',
        failureCaseId,
      };
      next.agentActivity = normalizeAgentActivity({
        ...(next.agentActivity || {}),
        phase: 'loop-stalled',
        label: '자동 루프 치명적 중단',
        detail: next.blocked.reason,
        finished: true,
        passed: false,
        failureCaseIds: [failureCaseId],
      }, actor);
    });
    if (current.id === task.id) leaf = updated;
    const parentId = updated.delegation?.parentTaskId;
    current = parentId ? await store.getTask(parentId) : null;
  }
  return leaf;
}

async function queuePartialMaxTurnRecovery(task, actor) {
  const recovering = await store.mutateTask(task.id, actor, task.version, 'MAX_TURNS_PARTIAL_RECOVERY_QUEUED', async (next) => {
    next.executionState = 'RECOVERING';
    next.executionRun = {
      ...(next.executionRun || {}),
      status: 'RECOVERING',
      recoveryReason: 'MAX_TURNS_WITH_PARTIAL_DELIVERABLE',
      heartbeatAt: nowIso(),
    };
  });
  await recoverPersistedAgentTask(recovering.id);
  return store.getTask(recovering.id);
}

async function progressAfterApproval(completedTask, actor) {
  const ordinary = await autoStartNextPlanTask(completedTask, actor);
  if (ordinary.decision === 'START' || !completedTask.delegation?.parentTaskId) return ordinary;
  const parent = await store.getTask(completedTask.delegation.parentTaskId);
  if (!parent?.recovery?.childTaskIds?.length) return ordinary;
  const tasks = await store.listTasks();
  if (!parent.recovery.childTaskIds.every((id) => tasks.find((item) => item.id === id)?.status === 'DONE')) return ordinary;
  const finalized = await store.mutateTask(parent.id, actor, parent.version, 'MAX_TURNS_RECOVERY_COMPLETED', async (next) => {
    const at = nowIso();
    next.status = 'DONE';
    next.executionState = 'IDLE';
    next.blocked = null;
    next.completedAt = at;
    next.archived = true;
    next.archivedAt = at;
    next.archivedByUserId = actor.id;
    next.verification = { status: 'PASSED', passed: true, profile: 'recovery-aggregate', finishedAt: at, childTaskIds: next.recovery.childTaskIds };
    next.review = { status: 'APPROVED', reviewerUserId: actor.id, reviewerProfileId: next.reviewerProfileId, comment: 'All bounded recovery tasks passed and were approved.', reviewedAt: at, automaticRecovery: true };
    next.recovery = { ...next.recovery, completedAt: at };
  });
  await store.recordAudit(actor.id, 'MAX_TURNS_RECOVERY_PARENT_COMPLETED', { taskId: finalized.id, childTaskIds: finalized.recovery.childTaskIds });
  return autoStartNextPlanTask(finalized, actor);
}

async function autoStartNextPlanTask(completedTask, actor) {
  const selection = selectAutomaticNextPlanTask(await store.listTasks(), completedTask);
  if (selection.decision !== 'START') {
    await store.recordAudit(actor.id, 'PLAN_AUTO_PROGRESSION_PAUSED', {
      planId: completedTask.planId || null,
      completedTaskId: completedTask.id,
      reason: selection.reason,
      candidateTaskIds: selection.candidates,
    });
    return { ...selection, task: null, worker: null };
  }
  const current = await store.getTask(selection.task.id);
  try {
    await requireCompletedDependencies(current);
    await requireAvailableTaskScope(current);
    const config = await loadConfig();
    const executionSelection = selectExecutor(current, config, {
      quality: 'auto',
      executorId: current.executorProfileId || '',
    });
    const reviewSelection = selectReviewer(current, config, {
      quality: 'high',
      reviewerProfileId: current.reviewerProfileId || '',
      executorProfileId: executionSelection.candidate?.id || current.executorProfileId || '',
    });
    if (!executionSelection.candidate || !reviewSelection.candidate) {
      throw new Error('No eligible execution or review AI profile is available.');
    }
    const queued = await store.mutateTask(current.id, actor, current.version, 'PLAN_NEXT_TASK_AUTO_QUEUED', async (next) => {
      next.assigneeUserId = actor.id;
      next.reviewerUserId = null;
      next.executorProfileId = executionSelection.candidate.id;
      next.reviewerProfileId = reviewSelection.candidate.id;
      next.executionMode = 'AGENT';
      next.executionState = 'QUEUED';
      next.blocked = null;
      next.review = null;
      next.executor = sanitizeExecutorInput(executionSelection.executor, { actorUserId: actor.id, at: nowIso() });
    });
    const worker = launchBoardWorker(queued, actor, serviceSessionCookie(actor.id), {
      executorId: queued.executorProfileId,
      reviewerProfileId: queued.reviewerProfileId,
    });
    await store.recordAudit(actor.id, 'PLAN_NEXT_TASK_AUTO_STARTED', {
      planId: queued.planId,
      completedTaskId: completedTask.id,
      taskId: queued.id,
      workerPid: worker.pid || null,
    });
    return { decision: 'START', reason: selection.reason, task: queued, worker };
  } catch (error) {
    await store.recordAudit(actor.id, 'PLAN_AUTO_PROGRESSION_PAUSED', {
      planId: completedTask.planId,
      completedTaskId: completedTask.id,
      candidateTaskIds: selection.candidates,
      reason: 'START_FAILED',
      error: error.message,
    });
    return { decision: 'ASK', reason: 'START_FAILED', task: current, worker: null, error: error.message };
  }
}

function launchBoardWorker(task, actor, cookie, options = {}) {
  const existing = boardWorkers.get(task.id);
  if (existing) return { status: 'RUNNING', taskId: task.id, pid: existing.child.pid };
  const args = [
    path.join(projectRoot, 'bin', 'team-loop.js'),
    'worker', 'once',
    '--project', 'team-loop',
    '--quality', String(options.quality || 'auto'),
    '--to', 'review',
    '--isolate',
    '--json',
    '--task-id', task.id,
  ];
  if (options.localOnly) args.push('--local-only');
  if (options.executorId) args.push('--executor-id', String(options.executorId));
  if (options.maxTurns) args.push('--max-turns', String(options.maxTurns));
  if (options.retry) args.push('--retry', String(options.retry));
  const child = spawn(process.execPath, args, {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      TEAM_LOOP_URL: `http://127.0.0.1:${port}`,
      TEAM_LOOP_SESSION_COOKIE: cookie,
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  const worker = {
    child,
    launchedAt: nowIso(),
    lastHeartbeatAt: nowIso(),
    heartbeat: null,
  };
  worker.heartbeat = setInterval(() => { worker.lastHeartbeatAt = nowIso(); }, 5_000);
  worker.heartbeat.unref();
  boardWorkers.set(task.id, worker);
  store.recordAudit(actor.id, 'BOARD_WORKER_LAUNCHED', { taskId: task.id, pid: child.pid }).catch(() => {});
  child.once('error', (error) => finishBoardWorker(task.id, actor, 1, error.message));
  child.once('close', (code) => finishBoardWorker(task.id, actor, Number(code ?? 1), ''));
  return { status: 'LAUNCHED', taskId: task.id, pid: child.pid };
}

async function recoverPersistedAgentTask(taskId) {
  let task = await store.getTask(taskId);
  if (!task || task.executionState !== 'RECOVERING') return;
  const actor = await store.getUser(task.assigneeUserId || task.creatorUserId);
  if (!actor?.active) throw new Error('Task owner is unavailable for recovery.');
  const isolatedRoot = worktreePath(workspaceRoot, task.id);
  if (!task.executionRun?.isolated) {
    await store.mutateTask(task.id, actor, task.version, 'TASK_RECOVERY_BLOCKED', async (next) => {
      next.status = 'BLOCKED';
      next.executionState = 'IDLE';
      next.executionRun = {
        ...(next.executionRun || {}),
        status: 'BLOCKED',
        finishedAt: nowIso(),
        recoveryReason: 'NO_ISOLATED_WORKTREE',
      };
      next.blocked = {
        reason: '이전 실행이 격리 worktree 없이 중단되어 변경물의 소유권을 안전하게 판별할 수 없습니다.',
        byUserId: actor.id,
        at: nowIso(),
        automatic: true,
      };
      next.agentActivity = normalizeAgentActivity({
        ...(next.agentActivity || {}),
        phase: 'recovery-blocked',
        label: '자동 복구 차단',
        detail: next.blocked.reason,
        finished: true,
        passed: false,
      }, actor);
    });
    return;
  }

  const hasChanges = existsSync(isolatedRoot) && await worktreeHasChanges(workspaceRoot, task.id);
  if (hasChanges) {
    let verification;
    await verifier.withWorkspaceLock(isolatedRoot, async () => {
      try {
        verification = await verifier.runLocked(task, isolatedRoot);
      } catch (error) {
        verification = {
          status: 'ERROR',
          profile: task.verificationProfile,
          startedAt: nowIso(),
          finishedAt: nowIso(),
          passed: false,
          error: error.message,
        };
      }
    });
    task = await saveVerificationResult(task.id, actor, task.version, verification);
    if (verification.passed) {
      task = await store.mutateTask(task.id, actor, task.version, 'TASK_RECOVERY_VERIFIED', async (next) => {
        next.status = 'REVIEW';
        next.executionState = 'IDLE';
        next.executionRun = { ...(next.executionRun || {}), status: 'RECOVERED', finishedAt: nowIso() };
        next.review = {
          status: 'PENDING',
          requestedAt: nowIso(),
          requestedByUserId: actor.id,
          reviewerProfileId: next.reviewerProfileId,
          recovered: true,
        };
        next.agentActivity = normalizeAgentActivity({
          ...(next.agentActivity || {}),
          phase: 'recovery-verified',
          label: '복구 검증 통과',
          detail: '격리 작업물 검증을 통과해 AI 검토 단계로 이동했습니다.',
          finished: true,
          passed: true,
        }, actor);
      });
      launchProfileReviewer(task, actor, serviceSessionCookie(actor.id));
      return;
    }
  }

  task = await store.mutateTask(task.id, actor, task.version, 'TASK_RECOVERY_REQUEUED', async (next) => {
    next.status = 'IN_PROGRESS';
    next.executionState = 'RUNNING';
    next.executionRun = {
      ...(next.executionRun || {}),
      status: 'RUNNING',
      isolated: true,
      recoveredAt: nowIso(),
      startedAt: next.executionRun?.startedAt || nowIso(),
      heartbeatAt: nowIso(),
    };
    next.agentActivity = normalizeAgentActivity({
      ...(next.agentActivity || {}),
      phase: hasChanges ? 'recovery-repair' : 'recovery-requeued',
      label: hasChanges ? '복구 후 수리 재실행' : '복구 후 작업 재실행',
      detail: hasChanges
        ? '격리 작업물 검증이 통과하지 않아 실패 증거를 유지한 채 수리 작업을 다시 실행합니다.'
        : '격리 작업물에 변경이 없어 작업을 다시 실행합니다.',
      passed: false,
    }, actor);
  });
  launchBoardWorker(task, actor, serviceSessionCookie(actor.id), {
    executorId: task.executorProfileId,
    reviewerProfileId: task.reviewerProfileId,
  });
}

function launchProfileReviewer(task, actor, cookie) {
  const args = [
    path.join(projectRoot, 'bin', 'team-loop.js'),
    'profile-review', task.id,
    '--json',
  ];
  const child = spawn(process.execPath, args, {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      TEAM_LOOP_URL: `http://127.0.0.1:${port}`,
      TEAM_LOOP_SESSION_COOKIE: cookie,
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  store.recordAudit(actor.id, 'PROFILE_REVIEWER_LAUNCHED', { taskId: task.id, pid: child.pid }).catch(() => {});
  child.once('close', (code) => {
    store.recordAudit(actor.id, 'PROFILE_REVIEWER_EXITED', { taskId: task.id, exitCode: Number(code ?? 1) }).catch(() => {});
  });
}

function serviceSessionCookie(userId) {
  return sessionCookie(issueSession(sessionSecret, userId), secureCookies).split(';', 1)[0];
}

function workerSessionCookie(request) {
  const token = parseCookies(request.headers.cookie || '').team_loop_session || '';
  return token ? `team_loop_session=${encodeURIComponent(token)}` : '';
}

function boardWorkerSnapshot(tasks = []) {
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  return [...boardWorkers.entries()].map(([taskId, worker]) => {
    const task = taskMap.get(taskId);
    return {
      taskId,
      pid: worker.child.pid,
      status: worker.child.exitCode == null ? 'RUNNING' : 'EXITED',
      launchedAt: worker.launchedAt,
      lastHeartbeatAt: worker.lastHeartbeatAt,
      phase: task?.agentActivity?.phase || (task?.executionState === 'QUEUED' ? 'queued' : 'launching'),
      activityUpdatedAt: task?.agentActivity?.updatedAt || null,
    };
  });
}

async function finishBoardWorker(taskId, actor, exitCode, errorMessage) {
  const worker = boardWorkers.get(taskId);
  if (!worker) return;
  clearInterval(worker.heartbeat);
  boardWorkers.delete(taskId);
  const current = await store.getTask(taskId).catch(() => null);
  if (current?.executionState === 'RUNNING') {
    await store.mutateTask(taskId, actor, current.version, 'BOARD_WORKER_EXITED', async (next) => {
      next.executionState = 'IDLE';
      next.executionRun = next.executionRun ? {
        ...next.executionRun,
        status: exitCode === 0 ? 'EXITED' : 'FAILED',
        finishedAt: nowIso(),
        exitCode,
      } : null;
      next.agentActivity = normalizeAgentActivity({
        ...(next.agentActivity || {}),
        phase: exitCode === 0 ? 'finished' : 'failed',
        label: exitCode === 0 ? '자동 작업자 종료' : '자동 작업자 실패',
        detail: errorMessage || `작업자 프로세스 종료 코드 ${exitCode}`,
        exitCode,
        finished: true,
      }, actor);
    }).catch(() => {});
  }

  await store.recordAudit(actor.id, 'BOARD_WORKER_EXITED', { taskId, exitCode, error: errorMessage || null }).catch(() => {});
  const finished = await store.getTask(taskId).catch(() => null);
  if (exitCode !== 0 && isExhaustedMaxTurnFailure(finished)) {
    await decomposeMaxTurnTask(finished, actor).catch(async (error) => {
      await store.recordAudit(actor.id, 'MAX_TURNS_DECOMPOSITION_FAILED', { taskId, error: error.message }).catch(() => {});
    });
  } else if (exitCode !== 0 && isRecoverablePartialMaxTurnFailure(finished)) {
    await queuePartialMaxTurnRecovery(finished, actor).catch(async (error) => {
      await store.recordAudit(actor.id, 'MAX_TURNS_PARTIAL_RECOVERY_FAILED', { taskId, error: error.message }).catch(() => {});
    });
  }
}

async function requireCompletedDependencies(task) {
  if (!task) throw new HttpError(404, 'Task not found.');
  const dependencyIds = Array.isArray(task.dependsOnTaskIds) ? task.dependsOnTaskIds : [];
  if (!dependencyIds.length) return;
  const tasks = await store.listTasks();
  const pending = dependencyIds.filter((id) => tasks.find((candidate) => candidate.id === id)?.status !== 'DONE');
  if (pending.length) {
    throw new HttpError(409, 'Task prerequisites are not complete.', { pendingDependencyIds: pending });
  }
}

async function requireAvailableTaskScope(task) {
  const overlap = findActiveScopeOverlap(await store.listTasks(), task);
  if (overlap) {
    throw new HttpError(409, `Scope locked: task ${overlap.id} is already active on an overlapping path scope.`);
  }
}

function requireTaskCreatorOrAdmin(task, actor) {
  if (task.creatorUserId !== actor.id && actor.role !== 'admin') {
    throw new HttpError(403, 'Only the task creator or an administrator can change the assignee.');
  }
}

function buildTaskTimeline(tasks = [], audits = []) {
  const byTask = new Map(tasks.map((task) => [task.id, {
    taskId: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    assigneeUserId: task.assigneeUserId,
    reviewerUserId: task.reviewerUserId,
    archived: Boolean(task.archived),
    schedule: normalizeExistingSchedule(task.schedule),
    events: [],
  }]));
  const auditByTask = new Map();
  for (const event of audits) {
    const taskId = event?.data?.taskId;
    if (!taskId || !byTask.has(taskId)) continue;
    if (!auditByTask.has(taskId)) auditByTask.set(taskId, []);
    auditByTask.get(taskId).push(event);
  }

  for (const task of tasks) {
    const taskAudits = auditByTask.get(task.id) || [];
    addTimelineEvent(byTask, task.id, {
      type: 'created',
      label: '생성',
      at: task.createdAt,
      actorUserId: task.creatorUserId,
      source: 'system',
    });
    const claimed = firstAudit(taskAudits, 'TASK_STARTED');
    if (claimed) addTimelineEvent(byTask, task.id, {
      type: 'claimed',
      label: '가져감',
      at: claimed.at,
      actorUserId: claimed.actorUserId,
      source: 'system',
    });
    const verified = lastAudit(taskAudits, ['VERIFICATION_FINISHED', 'VERIFICATION_FINISHED_AFTER_CONFLICT']);
    if (verified) addTimelineEvent(byTask, task.id, {
      type: 'verify-finish',
      label: '검증 완료',
      at: verified.at,
      actorUserId: verified.actorUserId,
      source: 'system',
    });
    if (task.schedule?.plannedStart) addTimelineEvent(byTask, task.id, {
      type: 'planned-start',
      label: '계획 시작',
      at: dateToIso(task.schedule.plannedStart),
      source: 'manual',
    });
    if (task.schedule?.plannedEnd) addTimelineEvent(byTask, task.id, {
      type: 'planned-end',
      label: '계획 마감',
      at: dateToIso(task.schedule.plannedEnd),
      source: 'manual',
    });
    if (task.review?.requestedAt) {
      const reviewRequested = firstAudit(taskAudits, 'REVIEW_REQUESTED');
      addTimelineEvent(byTask, task.id, {
        type: 'review',
        label: '리뷰 요청',
        at: reviewRequested?.at || task.review.requestedAt,
        actorUserId: reviewRequested?.actorUserId || task.review.requestedByUserId,
        source: 'system',
      });
    }
    if (task.completedAt) addTimelineEvent(byTask, task.id, {
      type: 'done',
      label: '완료',
      at: task.completedAt,
      actorUserId: task.review?.reviewerUserId,
      source: 'system',
    });
    const blocked = lastAudit(taskAudits, ['TASK_BLOCKED', 'REVIEW_REJECTED']);
    if (blocked && !task.completedAt && ['BLOCKED', 'IN_PROGRESS'].includes(task.status)) {
      const mapped = timelineEventFromAudit(blocked);
      if (mapped) addTimelineEvent(byTask, task.id, mapped);
    }
  }

  return [...byTask.values()].map((item) => ({
    ...item,
    events: item.events
      .filter((event) => event.at)
      .sort((a, b) => String(a.at).localeCompare(String(b.at))),
  }));
}

function firstAudit(events, action) {
  return events.find((event) => event.action === action) || null;
}

function lastAudit(events, actions) {
  const actionSet = new Set(Array.isArray(actions) ? actions : [actions]);
  return events.filter((event) => actionSet.has(event.action)).at(-1) || null;
}

function addTimelineEvent(byTask, taskId, event) {
  const item = byTask.get(taskId);
  if (!item || !event.at) return;
  item.events.push(event);
}

function timelineEventFromAudit(event) {
  const map = {
    TASK_AUTO_QUEUED: ['queued', '에이전트 대기열 등록'],
    TASK_AGENT_QUEUED: ['queued', '에이전트 대기열 등록'],
    BOARD_WORKER_LAUNCHED: ['worker', '작업자 프로세스 시작'],
    BOARD_WORKER_EXITED: ['worker-exit', '작업자 프로세스 종료'],
    TASK_STARTED: ['claimed', '가져감'],
    VERIFICATION_FINISHED: ['verify-finish', '검증 완료'],
    VERIFICATION_FINISHED_AFTER_CONFLICT: ['verify-finish', '검증 완료'],
    REVIEW_REQUESTED: ['review', '리뷰 요청'],
    REVIEW_APPROVED: ['done', '완료'],
    REVIEW_REJECTED: ['rejected', '반려'],
    TASK_BLOCKED: ['blocked', '막힘'],
    TASK_UNBLOCKED: ['unblocked', '재개'],
    TASK_ARCHIVED: ['archived', '아카이브'],
    TASK_UNARCHIVED: ['unarchived', '복원'],
    TASK_SCHEDULE_UPDATED: ['schedule', '일정 수정'],
  };
  const [type, label] = map[event.action] || [];
  if (!type) return null;
  return {
    type,
    label,
    at: event.at,
    actorUserId: event.actorUserId,
    source: 'system',
  };
}

function fallbackDiscussionMemory(messages = []) {
  const selected = Array.isArray(messages) ? messages.filter((message) => String(message?.content || '').trim()) : [];
  if (selected.length === 0) throw new HttpError(400, 'Select at least one discussion message.');
  const first = selected[0];
  const compactMessages = selected
    .slice(-8)
    .map((message) => String(message.content || '').trim().replace(/\s+/g, ' ').slice(0, 240));
  return {
    title: String(first.content || '회의록').trim().replace(/\s+/g, ' ').slice(0, 80) || '회의록',
    summary: compactMessages.join('\n'),
    keyPoints: compactMessages.slice(-5),
    decisions: [],
    followUps: [],
    tags: ['meeting-notes'],
  };
}

function normalizeTaskSchedule(input = {}) {
  const plannedStart = normalizeDateOnly(input.plannedStart);
  const plannedEnd = normalizeDateOnly(input.plannedEnd);
  if (plannedStart && plannedEnd && plannedStart > plannedEnd) {
    throw new HttpError(400, 'Schedule start must be on or before the deadline.');
  }
  return {
    plannedStart,
    plannedEnd,
    note: String(input.note ?? '').trim().slice(0, 1000),
  };
}

function normalizeAgentActivity(input = {}, actor) {
  const phase = clipActivity(input.phase, 40) || 'working';
  const now = nowIso();
  const previousStartedAt = typeof input.startedAt === 'string' && input.startedAt ? input.startedAt : null;
  return {
    phase,
    label: clipActivity(input.label, 80) || phase,
    detail: clipActivity(input.detail, 240) || '',
    tool: clipActivity(input.tool, 40) || '',
    model: clipActivity(input.model, 80) || '',
    workspace: clipActivity(input.workspace, 300) || '',
    worktreeBranch: clipActivity(input.worktreeBranch, 160) || '',
    attempt: Number.isFinite(Number(input.attempt)) ? Number(input.attempt) : null,
    maxAttempts: Number.isFinite(Number(input.maxAttempts)) ? Number(input.maxAttempts) : null,
    exitCode: Number.isFinite(Number(input.exitCode)) ? Number(input.exitCode) : null,
    passed: typeof input.passed === 'boolean' ? input.passed : null,
    failureCaseIds: Array.isArray(input.failureCaseIds) ? input.failureCaseIds.map((item) => String(item).trim()).filter(Boolean).slice(0, 20) : [],
    learnedArtifacts: Array.isArray(input.learnedArtifacts) ? input.learnedArtifacts.slice(0, 20) : [],
    preflight: normalizeExecutionPreflight(input.preflight),
    startedAt: previousStartedAt || now,
    updatedAt: now,
    finishedAt: input.finished ? now : null,
    actorUserId: actor.id,
  };
}

function normalizeExecutionPreflight(input) {
  if (!input || typeof input !== 'object') return null;
  const budget = input.budget && typeof input.budget === 'object' ? input.budget : {};
  const selectedContext = input.selectedContext && typeof input.selectedContext === 'object' ? input.selectedContext : {};
  const executor = input.executor && typeof input.executor === 'object' ? input.executor : {};
  const decision = String(input.decision || '').toUpperCase();
  return {
    decision: ['RUN', 'SHRINK', 'ASK'].includes(decision) ? decision : 'ASK',
    reason: clipActivity(input.reason, 500),
    hardLimitExceeded: input.hardLimitExceeded === true,
    selectedContext: {
      id: clipActivity(selectedContext.id, 160) || null,
      sourceCount: Math.max(0, Number(selectedContext.sourceCount) || 0),
      estimatedTokens: Math.max(0, Number(selectedContext.estimatedTokens) || 0),
    },
    executor: {
      tool: clipActivity(executor.tool, 40),
      model: clipActivity(executor.model, 80) || null,
    },
    maxTurns: Math.max(1, Math.min(100, Number(input.maxTurns) || 1)),
    estimatedRunTokens: Math.max(0, Number(input.estimatedRunTokens) || 0),
    budget: {
      tokenBudget: Math.max(0, Number(budget.tokenBudget) || 0),
      costBudgetUsd: Math.max(0, Number(budget.costBudgetUsd) || 0),
      cumulativeTokens: Math.max(0, Number(budget.cumulativeTokens) || 0),
      cumulativeCostUsd: Math.max(0, Number(budget.cumulativeCostUsd) || 0),
      remainingTokens: Math.max(0, Number(budget.remainingTokens) || 0),
      remainingCostUsd: Math.max(0, Number(budget.remainingCostUsd) || 0),
    },
  };
}

function clipActivity(value, max) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : '';
}

function normalizeExistingSchedule(input = {}) {
  return {
    plannedStart: typeof input?.plannedStart === 'string' ? input.plannedStart : '',
    plannedEnd: typeof input?.plannedEnd === 'string' ? input.plannedEnd : '',
    note: typeof input?.note === 'string' ? input.note : '',
  };
}

function normalizeDateOnly(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00.000Z`))) {
    throw new HttpError(400, 'Schedule dates must use YYYY-MM-DD.');
  }
  return text;
}

function dateToIso(date) {
  return `${date}T00:00:00.000Z`;
}

async function requireUser(request) {
  const token = parseCookies(request.headers.cookie).team_loop_session;
  const session = readSession(sessionSecret, token);
  if (!session) throw new HttpError(401, 'Authentication required.');
  const user = await store.getUser(session.userId);
  if (!user || !user.active) throw new HttpError(401, 'Session user no longer exists or is disabled.');
  return user;
}

async function readBody(request, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

function normalizeApprovalPolicy(value) {
  const policy = String(value || 'USER_CONFIRM').trim().toUpperCase();
  if (!['USER_CONFIRM', 'AUTO_LOW_RISK', 'AUTO'].includes(policy)) {
    throw new HttpError(400, 'Unknown approval policy.');
  }
  return policy;
}

function safeArtifactName(value) {
  const name = path.basename(String(value || '').trim()).replace(/[\x00-\x1f<>:"/\\|?*]/g, '-').slice(0, 180);
  if (!name || name === '.' || name === '..') throw new HttpError(400, 'Artifact filename is required.');
  return name;
}

function taskArtifactPath(taskId, artifactId) {
  if (!/^tsk_[a-z0-9]+$/i.test(taskId) || !/^art_[a-z0-9]+$/i.test(artifactId)) throw new HttpError(400, 'Invalid artifact path.');
  return path.join(taskArtifactRoot, taskId, artifactId);
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

// 프로모션 리뷰어 provenance 판정을 독립적으로 검증할 수 있도록 노출한다.
export { resolvePromotionReview, server };
