// 토큰 효율과 추적성 계약이 퇴행하면 exit 1로 막는다.
// 다섯 영역을 한 번에 본다: 컨텍스트 크기, 최대 턴, context pack/receipt id,
// 리뷰 안전 상태, READY가 REVIEW보다 먼저 선택되는 START_WORK 우선순위.
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { computePreflightDecision, computeReviewPreflight, selectContextTier } from '../../src/cli/main.js';
import { ContextPackStore, ContextSeedRegistry } from '../../src/context-packs.js';
import { terminalMaxTurnDecision } from '../../src/max-turn-decomposition.js';
import { OrchestrationEngine } from '../../src/orchestration-engine.js';
import { sha256 } from '../../src/utils.js';

const CONTEXT_SEEDS = path.resolve('config/context-seeds.json');

// 조건이 거짓이면 위반 목록에 한 줄을 남긴다.
function expect(violations, contract, condition, detail) {
  if (!condition) violations.push(`${contract}: ${detail}`);
}

// 작은 작업이 큰 작업보다 확실히 적은 컨텍스트를 받는지 본다.
async function checkContextSize(violations) {
  const contract = 'context-size';
  expect(violations, contract, selectContextTier({ allowedPaths: ['src/cli/main.js'] }) === 'single-file',
    'a single allowed path must select the single-file tier');
  expect(violations, contract, selectContextTier({ allowedPaths: ['src/cli/main.js', 'src/context-packs.js'] }) === 'implementation',
    'multiple allowed paths must select the implementation tier');
  expect(violations, contract, selectContextTier({ allowedPaths: ['src/**'] }) === 'implementation',
    'a recursive glob must select the implementation tier');

  const registry = new ContextSeedRegistry(CONTEXT_SEEDS);
  await registry.initialize();
  const seeds = new Map(registry.list().map((seed) => [seed.id, seed]));
  const single = seeds.get('single-file');
  const implementation = seeds.get('implementation');
  if (!single || !implementation) {
    violations.push(`${contract}: config/context-seeds.json must define single-file and implementation seeds`);
    return;
  }
  expect(violations, contract, single.maxSourceCharacters < implementation.maxSourceCharacters / 2,
    `single-file characters (${single.maxSourceCharacters}) must stay under half of implementation (${implementation.maxSourceCharacters})`);
  expect(violations, contract, single.maxSourceChunks < implementation.maxSourceChunks,
    `single-file chunks (${single.maxSourceChunks}) must stay under implementation (${implementation.maxSourceChunks})`);
}

// 턴 상한과 예산 잔량이 실행 전에 그대로 드러나는지 본다.
function checkMaximumTurns(violations) {
  const contract = 'maximum-turns';
  const preflight = computePreflightDecision({
    task: {
      delegation: { budget: { tokenBudget: 100_000, costBudgetUsd: 5 } },
      automationGuard: { cumulativeTokens: 10_000, cumulativeCostUsd: 1.25 },
    },
    contextPlan: { id: 'ctx_small', estimatedTokens: 2_000, sources: [{}, {}] },
    tool: 'claude-code',
    model: 'sonnet',
    maxTurns: 8,
  });
  expect(violations, contract, preflight.decision === 'RUN', `an affordable run must decide RUN, got ${preflight.decision}`);
  expect(violations, contract, preflight.maxTurns === 8, `the turn ceiling must be reported verbatim, got ${preflight.maxTurns}`);
  expect(violations, contract, preflight.budget.remainingTokens === 90_000,
    `remaining tokens must be budget minus cumulative, got ${preflight.budget.remainingTokens}`);
  expect(violations, contract, preflight.selectedContext.sourceCount === 2,
    `the selected context must report its source count, got ${preflight.selectedContext.sourceCount}`);

  const shallow = terminalMaxTurnDecision({ delegation: { depth: 0 }, automationGuard: { totalRuns: 1 } });
  expect(violations, contract, shallow.action === 'DECOMPOSE' && shallow.maxTurns === 12,
    `exhausted shallow work must decompose with a bounded ceiling, got ${JSON.stringify(shallow)}`);
  const escalated = terminalMaxTurnDecision({ delegation: { depth: 2 }, automationGuard: { totalRuns: 1 } });
  expect(violations, contract, escalated.action === 'ESCALATE_ONCE' && escalated.maxTurns === 24,
    `depth-2 work must escalate exactly once, got ${JSON.stringify(escalated)}`);
  const terminal = terminalMaxTurnDecision({ delegation: { depth: 2 }, automationGuard: { totalRuns: 2, circuitOpen: true } });
  expect(violations, contract, terminal.action === 'BLOCK_CRITICAL' && terminal.maxTurns === 0,
    `an exhausted circuit must stop spending turns, got ${JSON.stringify(terminal)}`);
}

// 잠근 context pack이 추적 가능한 id와 무결성 영수증을 남기는지 본다.
async function checkContextPackReceipts(violations) {
  const contract = 'context-pack-receipts';
  const directory = await mkdtemp(path.join(os.tmpdir(), 'token-efficiency-'));
  try {
    await writeFile(path.join(directory, 'source.md'), 'verified source', 'utf8');
    const store = new ContextPackStore({ dataDirectory: directory, workspaceRoot: directory });
    await store.initialize();
    const actor = { id: 'owner', role: 'member' };
    const seed = { id: 'test', label: 'Test', maxSourceCharacters: 1000, layers: ['L0', 'L1'] };
    const record = await store.record(actor, seed, {
      goal: 'Verify receipt',
      contract: {
        packId: 'receipt-test',
        requiredInputs: [{ path: 'source.md', sha256: sha256('verified source') }],
        readOrder: ['source.md'],
        writeScope: [],
        forbiddenActions: [],
      },
      sources: {
        sources: [{ path: 'source.md', chunk: 0, text: 'verified source' }],
        sourceCount: 1,
        characters: 15,
        estimatedTokens: 4,
        budgetCharacters: 1000,
      },
    });
    expect(violations, contract, Boolean(record.id), 'a recorded pack must carry an id');

    const locked = await store.lockPack(record.id, actor);
    expect(violations, contract, locked.status === 'LOCKED', `locking must mark the pack LOCKED, got ${locked.status}`);
    expect(violations, contract, locked.receipt?.integrity?.ok === true, 'a locked pack must carry a passing integrity receipt');
    expect(violations, contract, locked.receipt?.stages?.serialized === true, 'the receipt must record the serialized stage');
    expect(violations, contract, locked.id === record.id, 'the receipt must stay bound to the recorded pack id');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// 리뷰 예산이 바닥나도 사람 승인 상태를 덮어쓰지 않는지 본다.
function checkReviewSafeState(violations) {
  const contract = 'review-safe-state';
  const exhausted = computeReviewPreflight({
    status: 'REVIEW',
    review: { status: 'PENDING' },
    aiReviewBudget: { tokenBudget: 10_000, costBudgetUsd: 2, cumulativeTokens: 10_000, cumulativeCostUsd: 0.5 },
  }, { profileId: 'codex-review', contextTokens: 900, maxTurns: 8 });
  expect(violations, contract, exhausted.blocked === true, 'an exhausted AI review budget must block the review run');
  expect(violations, contract, /User approval remains pending/.test(String(exhausted.reason ?? '')),
    `blocking must preserve pending approval, got reason "${exhausted.reason}"`);
  expect(violations, contract, exhausted.context?.profileId === 'codex-review',
    'the blocked review must still report which profile was selected');
}

// READY 작업이 승인 대기 중인 REVIEW 작업에 가려지지 않는지 본다.
async function checkStartWorkPriority(violations) {
  const contract = 'start-work-priority';
  const policy = {
    constitutionVersion: '0.1.0',
    constitutionStatus: 'DRAFT',
    defaultReadBudgetTokens: 12000,
    decisionTable: [
      ['PROJECT_NOT_FOUND', 'ASK', 'project_register'],
      ['PROJECT_AMBIGUOUS', 'ASK', 'project_select'],
      ['WORK_BLOCKED', 'YES', 'work_inspect'],
      ['ACTIVE_WORK_WITH_VALID_HANDOFF', 'YES', 'work_inspect'],
      ['ACTIVE_WORK_WITH_STALE_HANDOFF', 'YES', 'work_inspect'],
      ['NO_ACTIVE_WORK_WITH_GOAL', 'YES', 'create_task'],
      ['USER_GOAL_REQUIRED', 'ASK', 'request_goal'],
    ].map(([reasonCode, decision, action], priority) => ({ reasonCode, decision, action, priority })),
  };
  const works = [
    { id: 'awaiting-approval', title: 'awaiting-approval', status: 'REVIEW', version: 1, updatedAt: '2026-07-25T00:00:00.000Z', priority: 1 },
    { id: 'ready-to-run', title: 'ready-to-run', status: 'READY', version: 1, updatedAt: '2026-07-25T00:00:00.000Z', priority: 100 },
  ];
  const engine = new OrchestrationEngine({
    constitutionCompiler: { policy: () => policy },
    entryService: {
      portfolio: async () => ({ projects: [{ id: 'team-loop', title: 'team-loop', purpose: '', location: '', activeWorkCount: 2, entryRef: 'project://team-loop/entry' }] }),
      projectEntry: async () => ({ activeWorks: works }),
      latestHandoff: async () => null,
      readPlan: async (projectId, input) => ({
        projectId,
        budget: { maxTokens: input.maxTokens },
        required: [`project://${projectId}/entry`],
      }),
    },
  });
  const decision = await engine.enter({ intent: 'START_WORK', projectId: 'team-loop' }, works);
  expect(violations, contract, decision.work?.id === 'ready-to-run',
    `START_WORK must select ready execution work, got ${decision.work?.id}`);
}

// 다섯 계약을 모두 돌려 위반 목록을 만든다.
export async function checkTokenEfficiency() {
  const violations = [];
  await checkContextSize(violations);
  checkMaximumTurns(violations);
  await checkContextPackReceipts(violations);
  checkReviewSafeState(violations);
  await checkStartWorkPriority(violations);
  return violations;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invokedDirectly) {
  const violations = await checkTokenEfficiency();
  if (violations.length) {
    console.error(`Token efficiency contracts regressed (${violations.length}):`);
    violations.forEach((violation) => console.error(`  - ${violation}`));
    process.exit(1);
  }
  console.log('Token efficiency contracts hold: context-size, maximum-turns, context-pack-receipts, review-safe-state, start-work-priority');
}
