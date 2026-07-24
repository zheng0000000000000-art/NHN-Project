const ACTIVE_STATUSES = new Set(['READY', 'IN_PROGRESS', 'REVIEW', 'BLOCKED']);

export class OrchestrationEngine {
  constructor({ constitutionCompiler, entryService }) {
    this.constitution = constitutionCompiler;
    this.entryService = entryService;
  }

  async enter({ projectId = null, intent = '', currentPath = '' } = {}, tasks = []) {
    const policy = this.constitution.policy();
    const portfolio = await this.entryService.portfolio(tasks);
    const selection = selectProject(policy, portfolio.projects, { projectId, currentPath });
    if (selection.decision !== 'YES') return envelope(policy, selection);

    const selectedProject = selection.project;
    const entry = await this.entryService.projectEntry(selectedProject.id, selectedProject.id === 'team-loop' ? tasks : [], []);
    const activeWorks = entry.activeWorks || [];
    const blocked = activeWorks.filter((item) => item.status === 'BLOCKED');
    if (blocked.length) {
      const work = newest(blocked);
      return envelope(policy, {
        ...ruleResult(policy, 'WORK_BLOCKED', { projectId: selectedProject.id, workId: work.id }),
        project: projectSummary(selectedProject),
        work,
        readPlan: await this.entryService.readPlan(selectedProject.id, { intent: 'resume', workId: work.id, maxTokens: policy.defaultReadBudgetTokens }),
      });
    }
    if (activeWorks.length) {
      const work = newest(activeWorks);
      const handoff = await this.entryService.latestHandoff(selectedProject.id, work.id);
      const valid = handoff && Number(handoff.revision) === Number(work.version);
      return envelope(policy, {
        ...ruleResult(policy, valid ? 'ACTIVE_WORK_WITH_VALID_HANDOFF' : 'ACTIVE_WORK_WITH_STALE_HANDOFF', { projectId: selectedProject.id, workId: work.id }),
        project: projectSummary(selectedProject),
        work,
        readPlan: await this.entryService.readPlan(selectedProject.id, { intent: 'resume', workId: work.id, maxTokens: policy.defaultReadBudgetTokens }),
      });
    }
    if (String(intent).trim()) {
      return envelope(policy, {
        ...ruleResult(policy, 'NO_ACTIVE_WORK_WITH_GOAL', { projectId: selectedProject.id, goal: String(intent).trim().slice(0, 2000) }),
        project: projectSummary(selectedProject),
        readPlan: await this.entryService.readPlan(selectedProject.id, { intent: 'new-work', maxTokens: policy.defaultReadBudgetTokens }),
      });
    }
    return envelope(policy, {
      ...ruleResult(policy, 'USER_GOAL_REQUIRED', { projectId: selectedProject.id }),
      project: projectSummary(selectedProject),
      readPlan: await this.entryService.readPlan(selectedProject.id, { intent: 'new-work', maxTokens: policy.defaultReadBudgetTokens }),
    });
  }
}

function selectProject(policy, projects, { projectId, currentPath }) {
  if (projectId) {
    const project = projects.find((item) => item.id === projectId);
    return project
      ? { decision: 'YES', reasonCode: 'PROJECT_SELECTED', project }
      : ruleResult(policy, 'PROJECT_NOT_FOUND', { projectId });
  }
  const normalizedPath = normalizePath(currentPath);
  const pathMatches = normalizedPath
    ? projects.filter((item) => normalizePath(item.location) === normalizedPath || normalizedPath.startsWith(`${normalizePath(item.location)}/`))
    : [];
  if (pathMatches.length === 1) return { decision: 'YES', reasonCode: 'PROJECT_MATCHED_CURRENT_PATH', project: pathMatches[0] };
  if (projects.length === 1) return { decision: 'YES', reasonCode: 'ONLY_PROJECT', project: projects[0] };
  const withActiveWork = projects.filter((item) => Number(item.activeWorkCount) > 0);
  if (withActiveWork.length === 1) return { decision: 'YES', reasonCode: 'ONLY_ACTIVE_PROJECT', project: withActiveWork[0] };
  return ruleResult(policy, 'PROJECT_AMBIGUOUS', { candidates: projects.map(projectSummary) });
}

function envelope(policy, result) {
  return {
    schemaVersion: 1,
    kind: 'LOOP_DECISION',
    decision: result.decision,
    reasonCode: result.reasonCode,
    action: result.action || null,
    requiresUserInput: result.decision === 'ASK',
    project: result.project || null,
    work: result.work || null,
    readPlan: result.readPlan || null,
    constitutionVersion: policy.constitutionVersion,
    constitutionStatus: policy.constitutionStatus,
    decidedAt: new Date().toISOString(),
  };
}

function newest(items) {
  return [...items].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
}

function normalizePath(value) {
  return String(value || '').trim().replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}

function projectSummary(project) {
  return { id: project.id, title: project.title, purpose: project.purpose, entryRef: project.entryRef };
}

function ruleResult(policy, reasonCode, argumentsValue = {}) {
  const rule = policy.decisionTable.find((item) => item.reasonCode === reasonCode);
  if (!rule) {
    return {
      decision: 'BLOCKED',
      reasonCode: 'SYSTEM_INTEGRITY_FAILED',
      action: { name: 'system_recover', arguments: { missingReasonCode: reasonCode } },
    };
  }
  return {
    decision: rule.decision,
    reasonCode: rule.reasonCode,
    action: { name: rule.action, arguments: argumentsValue },
  };
}
