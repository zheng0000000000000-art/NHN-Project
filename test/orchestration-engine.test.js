import test from 'node:test';
import assert from 'node:assert/strict';
import { OrchestrationEngine } from '../src/orchestration-engine.js';

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

test('zero-manual entry resumes the only active work with a bounded read plan', async () => {
  const engine = new OrchestrationEngine({
    constitutionCompiler: { policy: () => policy },
    entryService: entryService({
      projects: [project('team-loop', 1)],
      works: [work('tsk_1', 'IN_PROGRESS', 3)],
      handoff: { revision: 3 },
    }),
  });
  const decision = await engine.enter({}, [work('tsk_1', 'IN_PROGRESS', 3)]);
  assert.equal(decision.decision, 'YES');
  assert.equal(decision.reasonCode, 'ACTIVE_WORK_WITH_VALID_HANDOFF');
  assert.equal(decision.action.name, 'work_inspect');
  assert.deepEqual(decision.readPlan.required, ['project://team-loop/entry', 'project://team-loop-tool-lane/handoff/current', 'work://tsk_1/contract', 'work://tsk_1/handoff/latest']);
  assert.equal(decision.constitutionVersion, '0.1.0');
  assert.equal(decision.latencyMs >= 0, true);
});

test('ambiguous projects ask instead of loading or mixing both projects', async () => {
  const engine = new OrchestrationEngine({
    constitutionCompiler: { policy: () => policy },
    entryService: entryService({ projects: [project('one', 0), project('two', 0)], works: [] }),
  });
  const decision = await engine.enter({}, []);
  assert.equal(decision.decision, 'ASK');
  assert.equal(decision.reasonCode, 'PROJECT_AMBIGUOUS');
  assert.equal(decision.action.name, 'project_select');
  assert.equal(decision.readPlan, null);
});

test('a plain user goal becomes a new-work action without requiring menu knowledge', async () => {
  const engine = new OrchestrationEngine({
    constitutionCompiler: { policy: () => policy },
    entryService: entryService({ projects: [project('team-loop', 0)], works: [] }),
  });
  const decision = await engine.enter({ intent: '경제 밸런스를 안정적으로 맞춰줘' }, []);
  assert.equal(decision.decision, 'YES');
  assert.equal(decision.reasonCode, 'NO_ACTIVE_WORK_WITH_GOAL');
  assert.equal(decision.action.name, 'create_task');
  assert.equal(decision.action.arguments.goal, '경제 밸런스를 안정적으로 맞춰줘');
});

test('orchestration action changes when the compiled constitution decision table changes', async () => {
  const changedPolicy = structuredClone(policy);
  changedPolicy.decisionTable.find((item) => item.reasonCode === 'NO_ACTIVE_WORK_WITH_GOAL').action = 'plan_experiment';
  const engine = new OrchestrationEngine({
    constitutionCompiler: { policy: () => changedPolicy },
    entryService: entryService({ projects: [project('team-loop', 0)], works: [] }),
  });
  const decision = await engine.enter({ intent: '새 실험을 시작해줘' }, []);
  assert.equal(decision.action.name, 'plan_experiment');
});

test('orchestration selects the highest-priority executable plan step', async () => {
  const works = [
    { ...work('blocked-by-dependency', 'READY'), priority: 1, dependencyBlocked: true, pendingDependencyIds: ['previous'] },
    { ...work('lower-priority', 'READY'), priority: 30, dependencyBlocked: false },
    { ...work('higher-priority', 'READY'), priority: 10, dependencyBlocked: false },
  ];
  const engine = new OrchestrationEngine({
    constitutionCompiler: { policy: () => policy },
    entryService: entryService({ projects: [project('team-loop', 3)], works }),
  });
  const decision = await engine.enter({}, works);
  assert.equal(decision.work.id, 'higher-priority');
});

test('START_WORK does not let pending approval hide ready execution work', async () => {
  const works = [
    { ...work('awaiting-approval', 'REVIEW'), priority: 1 },
    { ...work('ready-to-run', 'READY'), priority: 100 },
  ];
  const engine = new OrchestrationEngine({
    constitutionCompiler: { policy: () => policy },
    entryService: entryService({ projects: [project('team-loop', 2)], works }),
  });
  const decision = await engine.enter({ intent: 'START_WORK', projectId: 'team-loop' }, works);
  assert.equal(decision.work.id, 'ready-to-run');
});

function entryService({ projects, works, handoff = null }) {
  return {
    portfolio: async () => ({ projects }),
    projectEntry: async () => ({ activeWorks: works }),
    latestHandoff: async () => handoff,
    readPlan: async (projectId, input) => ({
      projectId,
      budget: { maxTokens: input.maxTokens },
      required: input.workId
        ? [`project://${projectId}/entry`, 'project://team-loop-tool-lane/handoff/current', `work://${input.workId}/contract`, `work://${input.workId}/handoff/latest`]
        : [`project://${projectId}/entry`, 'project://team-loop-tool-lane/handoff/current'],
    }),
  };
}

function project(id, activeWorkCount) {
  return { id, title: id, purpose: '', location: '', activeWorkCount, entryRef: `project://${id}/entry` };
}

function work(id, status, version = 1) {
  return { id, title: id, status, version, updatedAt: '2026-07-25T00:00:00.000Z' };
}
