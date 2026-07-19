import { buildTaskSpecMarkdown, taskSpecFilename } from './task-spec.js';
import { buildTaskResultMarkdown, taskResultFilename, taskResultSummary } from './task-result.js';
import { filterTasksByPeople } from './task-board-filter.js';
import { publicExecutionLabel } from './task-execution.js';
import { canReviewTask } from './review-policy.js';

const state = {
  user: null,
  users: [],
  tasks: [],
  taskTimeline: [],
  profiles: {},
  ai: { enabled: false, missing: [] },
  projectContext: { content: '', updatedAt: null, updatedByUserId: null },
  workspace: null,
  pollTimer: null,
  aiResults: null,
  usage: null,
  usageDays: 30,
  milestoneMonth: new Date().toISOString().slice(0, 7),
  milestoneFilter: { type: '', userId: '', query: '', date: '' },
  boardFilter: { assigneeUserId: '', reviewerUserId: '' },
  showLearningCreate: false,
  showHarnessCreate: false,
  activeView: 'loop',
  harnesses: [],
  skills: [],
  learningAudit: null,
  failures: [],
  failureSummary: { total: 0, open: 0, fixtureCandidates: 0, resolved: 0, ignored: 0, occurrences: 0 },
  discussions: { messages: [], memories: [] },
  aiSessions: [], selectedAISession: null, aiSessionQuery: '', aiLogMode: 'answers',
  runResults: [], activeRunScopes: [],
};

const columns = [
  ['READY', '준비'],
  ['IN_PROGRESS', '진행 중'],
  ['REVIEW', '리뷰'],
  ['BLOCKED', '막힘'],
  ['DONE', '완료'],
];

const judgingCriteria = [
  { no: 0, title: '제출 자격·실행 무결성', grade: 'T1', lane: '자동 하네스', summary: '제출물, 실행 링크, 금지 형식, 실행 오류처럼 심사 전에 탈락을 가르는 필수 조건입니다.', artifact: 'judging-submission-integrity' },
  { no: 1, title: '60초 영상 전달력', grade: 'T2', lane: '사람 리뷰', summary: '무음으로 봐도 30초 안에 게임과 AI 차별점이 보이고 계속 보고 싶어야 합니다.', artifact: 'judging-video-clarity' },
  { no: 2, title: 'AI 네이티브성', grade: 'T2', lane: '혼합 평가', summary: 'AI가 제작 보조가 아니라 런타임 재미, 선택, 상황 변화를 만들어야 합니다.', artifact: 'judging-ai-native-gameplay' },
  { no: 3, title: '기술 문서 품질', grade: 'T2', lane: '혼합 평가', summary: '프롬프트 목록이 아니라 구조, 검증, 실패 대응, 비용, 보안까지 설명해야 합니다.', artifact: 'judging-technical-documentation' },
  { no: 4, title: '저장소와 개발 이력', grade: 'T1~T2', lane: '자동 하네스', summary: '커밋, 코드, 문서가 실제 반복 개발과 역할 분담을 증명해야 합니다.', artifact: 'judging-repository-history' },
  { no: 5, title: '비용·운영 안정성', grade: 'T1~T2', lane: '자동 하네스', summary: 'API 비용을 통제하고 장애나 제한 상황에서도 게임이 최소 동작해야 합니다.', artifact: 'judging-ops-stability' },
  { no: 6, title: 'NHN 정합성', grade: 'T3', lane: '사람 리뷰', summary: 'NHN 장르, 서비스, 채용 방향과 어울리는지는 AI 참고 의견만 사용합니다.', artifact: 'judging-nhn-fit-human-review' },
];

const authView = document.querySelector('#auth-view');
const workspaceView = document.querySelector('#workspace-view');
const authError = document.querySelector('#auth-error');
const taskFormPanel = document.querySelector('#task-form-panel');
const taskFormError = document.querySelector('#task-form-error');
const aiPanel = document.querySelector('#ai-panel');
const aiError = document.querySelector('#ai-error');
const aiResults = document.querySelector('#ai-results');
const milestonePanel = document.querySelector('#milestone-panel');
const board = document.querySelector('#board');
const agentActivityPanel = document.querySelector('#agent-activity-panel');
const milestoneRanges = document.querySelector('#milestone-ranges');
const milestoneCalendar = document.querySelector('#milestone-calendar');
const milestoneStream = document.querySelector('#milestone-stream');
const usageView = document.querySelector('#usage-view');
const loopView = document.querySelector('#loop-view');
const boardView = document.querySelector('#board-view');
const harnessView = document.querySelector('#harness-view');
const caseWikiView = document.querySelector('#case-wiki-view');
const discussionView = document.querySelector('#discussion-view');
const aiLogsView = document.querySelector('#ai-logs-view');
const aiSessionList = document.querySelector('#ai-session-list');
const aiSessionDetail = document.querySelector('#ai-session-detail');
const harnessFormError = document.querySelector('#harness-form-error');
const harnessList = document.querySelector('#harness-list');
const skillList = document.querySelector('#skill-list');
const learningAuditPanel = document.querySelector('#learning-audit-panel');
const learningFormError = document.querySelector('#learning-form-error');
const learningApplyError = document.querySelector('#learning-apply-error');
const failureList = document.querySelector('#failure-list');
const caseArchive = document.querySelector('#case-archive');
const wikiContextPack = document.querySelector('#wiki-context-pack');
const wikiProjectHistory = document.querySelector('#wiki-project-history');
const wikiDiscussionMemories = document.querySelector('#wiki-discussion-memories');
const wikiJudgingCriteria = document.querySelector('#wiki-judging-criteria');
const discussionMessages = document.querySelector('#discussion-messages');
const discussionError = document.querySelector('#discussion-error');
const toast = document.querySelector('#toast');

const savedTheme = localStorage.getItem('team-loop-theme');
applyTheme(savedTheme || 'dark');
document.querySelector('#theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('team-loop-theme', next);
  applyTheme(next);
});

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const button = document.querySelector('#theme-toggle');
  if (button) button.textContent = theme === 'dark' ? '라이트 모드' : '다크 모드';
}

for (const tab of document.querySelectorAll('[data-auth-tab]')) {
  tab.addEventListener('click', () => {
    document.querySelectorAll('[data-auth-tab]').forEach((item) => item.classList.toggle('active', item === tab));
    document.querySelector('#login-form').classList.toggle('hidden', tab.dataset.authTab !== 'login');
    document.querySelector('#register-form').classList.toggle('hidden', tab.dataset.authTab !== 'register');
    authError.textContent = '';
  });
}

document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  authError.textContent = '';
  const form = new FormData(event.currentTarget);
  try {
    await api('/api/auth/login', { method: 'POST', body: Object.fromEntries(form) });
    await bootstrap();
  } catch (error) {
    authError.textContent = error.message;
  }
});

document.querySelector('#register-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  authError.textContent = '';
  const form = new FormData(event.currentTarget);
  try {
    await api('/api/auth/register', { method: 'POST', body: Object.fromEntries(form) });
    await bootstrap();
  } catch (error) {
    authError.textContent = error.message;
  }
});

document.querySelector('#logout-button').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST', body: {} });
  stopPolling();
  state.user = null;
  workspaceView.classList.add('hidden');
  authView.classList.remove('hidden');
});

document.querySelector('#refresh-button').addEventListener('click', () => refreshCurrentView(false));
document.querySelector('#new-task-button').addEventListener('click', () => taskFormPanel.classList.remove('hidden'));
document.querySelector('#close-task-form').addEventListener('click', () => taskFormPanel.classList.add('hidden'));
document.querySelector('#ai-assistant-button').addEventListener('click', () => aiPanel.classList.remove('hidden'));
document.querySelector('#close-ai-panel').addEventListener('click', () => aiPanel.classList.add('hidden'));
document.querySelector('#milestone-toggle').addEventListener('click', () => {
  milestonePanel.classList.toggle('hidden');
  document.querySelector('#milestone-toggle').classList.toggle('active', !milestonePanel.classList.contains('hidden'));
  if (!milestonePanel.classList.contains('hidden')) renderMilestonePlanner();
});

for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', async () => {
    switchView(button.dataset.view);
    if (state.activeView === 'usage') await loadUsage({ quiet: false });
    if (state.activeView === 'harnesses') {
      await loadLearningAudit({ quiet: true });
      renderHarnessDashboard();
    }
    if (state.activeView === 'case-wiki') renderCaseArchive();
    if (state.activeView === 'discussion') renderDiscussionBoard();
    if (state.activeView === 'ai-logs') await loadAISessions({ quiet: false });
  });
}
loopView.addEventListener('click', (event) => { const target = event.target.closest('[data-loop-view]'); if (target) switchView(target.dataset.loopView); });

document.querySelector('#ai-log-refresh').addEventListener('click', () => loadAISessions({ quiet: false }));
document.querySelector('#ai-log-search').addEventListener('input', (event) => { state.aiSessionQuery = event.target.value; renderAISessionList(); });
document.querySelector('#ai-log-mode').addEventListener('change', (event) => { state.aiLogMode = event.target.value; renderAISessionDetail(); });
aiSessionList.addEventListener('click', async (event) => { const button = event.target.closest('[data-ai-session-id]'); if (button) await loadAISession(button.dataset.aiSessionId); });

document.querySelector('#usage-refresh').addEventListener('click', () => loadUsage({ quiet: false }));
document.querySelector('#case-wiki-refresh').addEventListener('click', async () => {
  await bootstrap({ quiet: true });
  renderCaseArchive();
  showToast('WIKI를 갱신했습니다.');
});
document.querySelector('#usage-days').addEventListener('change', async (event) => {
  state.usageDays = Number(event.target.value) || 30;
  await loadUsage({ quiet: false });
});

document.querySelector('#discussion-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  discussionError.textContent = '';
  const form = event.currentTarget;
  try {
    await api('/api/discussions/messages', {
      method: 'POST',
      body: { content: form.elements.content.value },
    });
    form.reset();
    await bootstrap({ quiet: true });
    renderDiscussionBoard();
    showToast('대화에 보냈습니다.');
  } catch (error) {
    discussionError.textContent = error.message;
  }
});

document.querySelector('#discussion-ai-save').addEventListener('click', async () => {
  discussionError.textContent = '';
  const button = document.querySelector('#discussion-ai-save');
  if (!(state.discussions?.messages || []).length) {
    discussionError.textContent = '회의록으로 저장할 대화가 아직 없습니다.';
    return;
  }
  try {
    button.disabled = true;
    const result = await api('/api/discussions/ai-save', { method: 'POST', body: {} });
    await bootstrap({ quiet: true });
    renderDiscussionBoard();
    renderCaseArchive();
    showToast(result.duplicate ? '이미 저장된 회의록입니다.' : '대화를 회의록으로 저장했습니다.');
  } catch (error) {
    discussionError.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#milestone-prev').addEventListener('click', () => shiftMilestoneMonth(-1));
document.querySelector('#milestone-next').addEventListener('click', () => shiftMilestoneMonth(1));
document.querySelector('#milestone-event-filter').addEventListener('change', (event) => {
  state.milestoneFilter.type = event.target.value;
  renderMilestonePlanner();
});
document.querySelector('#milestone-user-filter').addEventListener('change', (event) => {
  state.milestoneFilter.userId = event.target.value;
  renderMilestonePlanner();
});
document.querySelector('#milestone-search').addEventListener('input', (event) => {
  state.milestoneFilter.query = event.target.value;
  renderMilestonePlanner();
});
document.querySelector('#milestone-clear-filter').addEventListener('click', () => {
  state.milestoneFilter = { type: '', userId: '', query: '', date: '' };
  renderMilestonePlanner();
});
document.querySelector('#schedule-form').addEventListener('change', (event) => {
  if (event.target.name === 'taskId') populateScheduleForm(event.target.value);
});
document.querySelector('#schedule-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const taskId = form.elements.taskId.value;
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;
  try {
    const payload = await api(`/api/tasks/${encodeURIComponent(taskId)}/schedule`, {
      method: 'POST',
      body: {
        expectedVersion: task.version,
        schedule: {
          plannedStart: form.elements.plannedStart.value,
          plannedEnd: form.elements.plannedEnd.value,
          note: form.elements.note.value,
        },
      },
    });
    replaceTask(payload.task);
    await bootstrap({ quiet: true });
    showToast('일정을 저장했습니다.');
  } catch (error) {
    showToast(error.message, true);
  }
});
document.querySelector('#milestone-panel').addEventListener('click', (event) => {
  const day = event.target.closest('[data-milestone-date]');
  if (day) {
    state.milestoneFilter.date = state.milestoneFilter.date === day.dataset.milestoneDate ? '' : day.dataset.milestoneDate;
    renderMilestonePlanner();
    return;
  }
  const button = event.target.closest('[data-schedule-task]');
  if (!button) return;
  const taskId = button.dataset.scheduleTask;
  const form = document.querySelector('#schedule-form');
  form.elements.taskId.value = taskId;
  populateScheduleForm(taskId);
  form.elements.plannedStart.focus();
});
document.querySelector('#board-assignee-filter').addEventListener('change', (event) => {
  state.boardFilter.assigneeUserId = event.target.value;
  render();
});
document.querySelector('#board-reviewer-filter').addEventListener('change', (event) => {
  state.boardFilter.reviewerUserId = event.target.value;
  render();
});
document.querySelector('#board-clear-filter').addEventListener('click', () => {
  state.boardFilter = { assigneeUserId: '', reviewerUserId: '' };
  populateBoardFilters();
  render();
});
agentActivityPanel?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-agent-task]');
  if (!button) return;
  const card = document.querySelector(`[data-task-card="${cssEscape(button.dataset.agentTask)}"]`);
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('task-card-focus');
    setTimeout(() => card.classList.remove('task-card-focus'), 1400);
  }
});

document.querySelector('#harness-refresh').addEventListener('click', async () => {
  await bootstrap({ quiet: true });
  await loadLearningAudit({ quiet: true });
  renderHarnessDashboard();
  showToast('하네스와 실패사례를 갱신했습니다.');
});

learningAuditPanel?.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-learning-audit-action]');
  if (!button) return;
  button.disabled = true;
  try {
    const action = button.dataset.learningAuditAction;
    if (action === 'refresh') {
      await loadLearningAudit({ quiet: false });
    } else if (action === 'apply-cleanup') {
      const planned = state.learningAudit?.actions?.length || 0;
      if (!planned) return;
      if (!window.confirm(`${planned} cleanup action(s) will archive duplicate or draft artifacts. Continue?`)) return;
      const payload = await api('/api/learning/audit/apply-cleanup', { method: 'POST', body: {} });
      state.learningAudit = payload.audit;
      await bootstrap({ quiet: true });
      await loadLearningAudit({ quiet: true });
      showToast(`Archived ${payload.applied.length} cleanup item(s).`);
    }
    renderHarnessDashboard();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#failure-status-filter').addEventListener('change', renderHarnessDashboard);
document.querySelector('#learning-create-toggle').addEventListener('click', () => {
  state.showLearningCreate = !state.showLearningCreate;
  renderHarnessDashboard();
});
document.querySelector('#harness-create-toggle').addEventListener('click', () => {
  state.showHarnessCreate = !state.showHarnessCreate;
  renderHarnessDashboard();
});

document.querySelector('#learning-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  learningFormError.textContent = '';
  const form = new FormData(event.currentTarget);
  try {
    await api('/api/learning/craft', {
      method: 'POST',
      body: {
        type: form.get('type'),
        id: form.get('id'),
        label: form.get('label'),
        description: form.get('description'),
        failureCaseIds: lines(form.get('failureCaseIds')),
        rules: lines(form.get('rules')),
      },
    });
    event.currentTarget.reset();
    await bootstrap({ quiet: true });
    renderHarnessDashboard();
    showToast('실패 묶음에서 DRAFT 학습 아티팩트를 만들었습니다.');
  } catch (error) {
    learningFormError.textContent = error.message;
  }
});

document.querySelector('#learning-apply-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  learningApplyError.textContent = '';
  const form = event.currentTarget;
  const task = state.tasks.find((item) => item.id === form.elements.taskId.value);
  if (!task) {
    learningApplyError.textContent = '적용할 작업을 선택하세요.';
    return;
  }
  const skillIds = [...form.elements.skillIds.selectedOptions].map((item) => item.value);
  try {
    await api(`/api/tasks/${encodeURIComponent(task.id)}/apply-learning`, {
      method: 'POST',
      body: {
        expectedVersion: task.version,
        harnessId: form.elements.harnessId.value || null,
        skillIds,
      },
    });
    await bootstrap({ quiet: true });
    renderHarnessDashboard();
    showToast('활성 하네스·스킬을 작업에 적용했습니다. 기존 검증은 무효화했습니다.');
  } catch (error) {
    learningApplyError.textContent = error.message;
  }
});

skillList.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-skill-action]');
  if (!button) return;
  const skill = state.skills.find((item) => item.id === button.dataset.skillId);
  if (!skill) return;
  button.disabled = true;
  try {
    const action = button.dataset.skillAction;
    await api(`/api/skills/${encodeURIComponent(skill.id)}/${action}`, {
      method: 'POST', body: { expectedVersion: skill.version },
    });
    await bootstrap({ quiet: true });
    renderHarnessDashboard();
    showToast(`스킬을 ${action === 'activate' ? '활성화' : '비활성화'}했습니다.`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#harness-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  harnessFormError.textContent = '';
  const form = new FormData(event.currentTarget);
  try {
    const commands = JSON.parse(String(form.get('commands') || '[]'));
    await api('/api/harnesses', {
      method: 'POST',
      body: {
        id: form.get('id'),
        label: form.get('label'),
        description: form.get('description'),
        commands,
      },
    });
    event.currentTarget.reset();
    event.currentTarget.elements.commands.value = JSON.stringify([{
      file: 'node', args: ['--test'], cwd: '.', expectedExit: 0, timeoutMs: 120000,
    }], null, 2);
    await bootstrap({ quiet: true });
    renderHarnessDashboard();
    showToast('DRAFT 하네스를 만들었습니다. 시험 통과 후 활성화하세요.');
  } catch (error) {
    harnessFormError.textContent = error.message;
  }
});

harnessList.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-harness-action]');
  if (!button) return;
  const harness = state.harnesses.find((item) => item.id === button.dataset.harnessId);
  if (!harness) return;
  button.disabled = true;
  try {
    const action = button.dataset.harnessAction;
    if (action === 'test') showToast(`${harness.id} 하네스를 시험하고 있습니다…`);
    const payload = await api(`/api/harnesses/${encodeURIComponent(harness.id)}/${action}`, {
      method: 'POST', body: { expectedVersion: harness.version },
    });
    await bootstrap({ quiet: true });
    renderHarnessDashboard();
    if (action === 'test') showToast(payload.test.passed ? '하네스 시험이 통과했습니다.' : '하네스 시험이 실패해 사례로 기록했습니다.', !payload.test.passed);
    else showToast(`하네스를 ${action === 'activate' ? '활성화' : '비활성화'}했습니다.`);
  } catch (error) {
    showToast(error.message, true);
    await bootstrap({ quiet: true });
    renderHarnessDashboard();
  } finally {
    button.disabled = false;
  }
});

failureList.addEventListener('click', async (event) => {
  const autoButton = event.target.closest('button[data-failure-auto-ids]');
  if (autoButton) {
    try {
      autoButton.disabled = true;
      const payload = await api('/api/learning/auto-craft', {
        method: 'POST',
        body: { failureCaseIds: autoButton.dataset.failureAutoIds.split(',').filter(Boolean) },
      });
      await bootstrap({ quiet: true });
      renderHarnessDashboard();
      showToast(`${payload.plan?.type || payload.type} DRAFT를 만들었습니다.`);
    } catch (error) {
      showToast(error.message, true);
    } finally {
      autoButton.disabled = false;
    }
    return;
  }
  const button = event.target.closest('button[data-failure-action]');
  if (!button) return;
  const failure = state.failures.find((item) => item.id === button.dataset.failureId);
  if (!failure) return;
  const action = button.dataset.failureAction;
  button.disabled = true;
  try {
    if (action === 'promote') {
      await api(`/api/failures/${encodeURIComponent(failure.id)}/promote`, { method: 'POST', body: {} });
    } else {
      const status = { resolve: 'RESOLVED', ignore: 'IGNORED', reopen: 'OPEN' }[action];
      const note = action === 'reopen' ? '' : (window.prompt('상태 변경 메모 (선택)') ?? '');
      await api(`/api/failures/${encodeURIComponent(failure.id)}/status`, { method: 'POST', body: { status, note } });
    }
    await bootstrap({ quiet: true });
    renderHarnessDashboard();
    showToast('실패사례 상태를 반영했습니다.');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#task-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  taskFormError.textContent = '';
  const form = new FormData(event.currentTarget);
  const body = Object.fromEntries(form);
  body.allowedPaths = lines(body.allowedPaths);
  body.acceptanceCriteria = lines(body.acceptanceCriteria);
  body.priority = Number(body.priority || 100);
  body.schedule = {
    plannedStart: body.plannedStart || '',
    plannedEnd: body.plannedEnd || '',
    note: body.scheduleNote || '',
  };
  delete body.plannedStart;
  delete body.plannedEnd;
  delete body.scheduleNote;
  try {
    await api('/api/tasks', { method: 'POST', body });
    resetTaskForm(event.currentTarget);
    taskFormPanel.classList.add('hidden');
    await bootstrap({ quiet: true });
    showToast('작업을 만들었습니다.');
  } catch (error) {
    taskFormError.textContent = error.message;
  }
});

document.querySelector('#ai-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const goal = new FormData(event.currentTarget).get('goal');
  await runAIGlobal('/api/ai/draft-task', { goal }, 'draft');
});

document.querySelector('#ai-next-tasks-button').addEventListener('click', async () => {
  const objective = document.querySelector('#ai-form').elements.goal.value;
  await runAIGlobal('/api/ai/next-tasks', { objective }, 'suggestions');
});

document.querySelector('#project-context-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const payload = await api('/api/project-context', {
      method: 'PUT',
      body: { content: form.elements.content.value },
    });
    state.projectContext = payload.projectContext;
    renderProjectContext();
    showToast('Project context saved.');
  } catch (error) {
    showToast(error.message, true);
  }
});

aiResults.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-ai-draft-index]');
  if (!button || !state.aiResults) return;
  const index = Number(button.dataset.aiDraftIndex);
  const drafts = state.aiResults.kind === 'draft'
    ? [state.aiResults.value]
    : state.aiResults.value.suggestions;
  const draft = drafts[index];
  if (!draft) return;
  applyDraftToForm(draft);
});

board.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const task = state.tasks.find((item) => item.id === button.dataset.taskId);
  if (!task) return;
  const action = button.dataset.action;
  if (action === 'download-spec') {
    downloadTaskSpec(task);
    return;
  }
  if (action === 'download-result') {
    downloadTaskResult(task);
    return;
  }
  button.disabled = true;
  try {
    if (action === 'dispatch-command') {
      await copyDispatchCommand(task);
      return;
    }
    if (action === 'claim') await taskAction(task, 'claim');
    if (action === 'queue-agent') await taskAction(task, 'queue-agent');
    if (action === 'cancel-agent') await taskAction(task, 'cancel-agent');
    if (action === 'verify') {
      showToast('검증을 실행하고 있습니다…');
      await taskAction(task, 'verify');
    }
    if (action === 'request-review') await taskAction(task, 'request-review');
    if (action === 'approve') {
      const comment = window.prompt('승인 의견 (선택)') ?? '';
      await taskAction(task, 'review', { decision: 'APPROVE', comment });
    }
    if (action === 'reject') {
      const comment = window.prompt('반려 이유를 입력하세요.') ?? '';
      if (!comment.trim()) throw new Error('반려 이유가 필요합니다.');
      await taskAction(task, 'review', { decision: 'REJECT', comment });
    }
    if (action === 'block') {
      const reason = window.prompt('막힌 이유를 입력하세요.') ?? '';
      if (!reason.trim()) throw new Error('막힘 이유가 필요합니다.');
      await taskAction(task, 'block', { reason });
    }
    if (action === 'unblock') await taskAction(task, 'unblock');
    if (action === 'archive') await taskAction(task, 'archive');
    if (action === 'unarchive') await taskAction(task, 'unarchive');
    if (action === 'delete') {
      if (!window.confirm('이 작업을 삭제할까요? 되돌릴 수 없습니다.')) return;
      await taskAction(task, 'delete');
    }
    if (action === 'ai-brief') {
      showToast('AI 작업 브리프를 만들고 있습니다…');
      await taskAIAction(task, 'ai-brief');
    }
    if (action === 'ai-verification-summary') {
      showToast('AI 검증 요약을 만들고 있습니다…');
      await taskAIAction(task, 'ai-verification-summary');
    }
    await bootstrap({ quiet: true });
    showToast(action.startsWith('ai-') ? 'AI 제안을 저장했습니다.' : '상태를 반영했습니다.');
  } catch (error) {
    showToast(error.message, true);
    await bootstrap({ quiet: true });
  } finally {
    button.disabled = false;
  }
});

async function runAIGlobal(url, body, kind) {
  aiError.textContent = '';
  if (!state.ai.enabled) {
    aiError.textContent = `AI 설정이 필요합니다: ${(state.ai.missing || []).join(', ')}`;
    return;
  }
  setAIButtonsDisabled(true);
  aiResults.innerHTML = '<div class="empty">AI가 제안을 만들고 있습니다…</div>';
  try {
    const payload = await api(url, { method: 'POST', body });
    const value = kind === 'draft' ? payload.draft : payload.result;
    state.aiResults = { kind, value };
    renderAIResults();
  } catch (error) {
    aiResults.innerHTML = '';
    aiError.textContent = error.message;
  } finally {
    setAIButtonsDisabled(false);
  }
}

function setAIButtonsDisabled(disabled) {
  for (const button of document.querySelectorAll('#ai-form button')) button.disabled = disabled || !state.ai.enabled;
}

async function taskAction(task, action, extra = {}) {
  return api(`/api/tasks/${encodeURIComponent(task.id)}/${action}`, {
    method: 'POST',
    body: { expectedVersion: task.version, ...extra },
  });
}

function replaceTask(task) {
  const index = state.tasks.findIndex((item) => item.id === task.id);
  if (index === -1) state.tasks.push(task);
  else state.tasks[index] = task;
}

async function taskAIAction(task, action) {
  return api(`/api/tasks/${encodeURIComponent(task.id)}/${action}`, {
    method: 'POST',
    body: { expectedVersion: task.version },
  });
}

async function bootstrap({ quiet = true } = {}) {
  try {
    const data = await api('/api/bootstrap');
    Object.assign(state, data);
    authView.classList.add('hidden');
    workspaceView.classList.remove('hidden');
    document.querySelector('#current-user').textContent = `${state.user.name} · ${state.user.role}`;
    document.querySelector('#workspace-root').textContent = state.workspace.root;
    populateTaskForm();
    populateBoardFilters();
    renderAIStatus();
    renderProjectContext();
    render();
    renderHarnessDashboard();
    renderLearningLoop();
    switchView(state.activeView);
    if (state.activeView === 'usage') await loadUsage({ quiet: true });
    if (state.activeView === 'case-wiki') renderCaseArchive();
    if (state.activeView === 'discussion') renderDiscussionBoard();
    startPolling();
    if (!quiet) showToast('최신 상태를 불러왔습니다.');
  } catch (error) {
    if (error.status === 401) {
      stopPolling();
      workspaceView.classList.add('hidden');
      authView.classList.remove('hidden');
      return;
    }
    if (!quiet) showToast(error.message, true);
  }
}

function populateTaskForm() {
  const form = document.querySelector('#task-form');
  const assignee = form.elements.assigneeUserId;
  const reviewer = form.elements.reviewerUserId;
  const currentAssignee = assignee.value;
  const currentReviewer = reviewer.value;
  assignee.innerHTML = '<option value="">미지정</option>' + state.users.map(userOption).join('');
  reviewer.innerHTML = '<option value="">누구나(담당자 제외)</option>' + state.users.map(userOption).join('');
  assignee.value = currentAssignee;
  reviewer.value = currentReviewer;

  const supersedes = form.elements.supersedesTaskId;
  const currentSupersedes = supersedes.value;
  supersedes.innerHTML = '<option value="">없음 · 새 작업</option>' + state.tasks
    .filter((task) => !task.archived && task.status !== 'DONE')
    .map((task) => `<option value="${escapeHtml(task.id)}">${escapeHtml(task.title)} · ${escapeHtml(statusLabel(task.status))}</option>`)
    .join('');
  if ([...supersedes.options].some((option) => option.value === currentSupersedes)) supersedes.value = currentSupersedes;

  const profile = form.elements.verificationProfile;
  const currentProfile = profile.value;
  profile.innerHTML = Object.values(state.profiles).map((item) =>
    `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)} · ${item.commandCount} checks</option>`
  ).join('');
  if ([...profile.options].some((option) => option.value === currentProfile)) profile.value = currentProfile;
}

function renderProjectContext() {
  const form = document.querySelector('#project-context-form');
  if (!form) return;
  if (document.activeElement !== form.elements.content) {
    form.elements.content.value = state.projectContext?.content || '';
  }
  const meta = document.querySelector('#project-context-meta');
  const updatedAt = state.projectContext?.updatedAt;
  meta.textContent = updatedAt ? `Updated ${new Date(updatedAt).toLocaleString()}` : 'Not saved yet';
}

function resetTaskForm(form) {
  form.reset();
  form.elements.priority.value = '100';
  form.elements.allowedPaths.value = '**';
  form.elements.plannedStart.value = '';
  form.elements.plannedEnd.value = '';
  form.elements.scheduleNote.value = '';
  form.elements.supersedesTaskId.value = '';
  populateTaskForm();
}

function userOption(user) {
  return `<option value="${escapeHtml(user.id)}">${escapeHtml(user.name)}</option>`;
}

function renderAIStatus() {
  const badge = document.querySelector('#ai-status');
  const disabled = document.querySelector('#ai-disabled-message');
  badge.textContent = state.ai.enabled ? `AI ${state.ai.provider || 'openai'} ${state.ai.model}` : 'AI 꺼짐';
  badge.className = `badge ${state.ai.enabled ? 'pass' : 'fail'}`;
  disabled.classList.toggle('hidden', state.ai.enabled);
  disabled.textContent = state.ai.enabled
    ? ''
    : `서버에 ${(state.ai.missing || []).join(', ')} 환경 변수를 설정하면 AI 기능이 활성화됩니다.`;
  setAIButtonsDisabled(false);
}

function renderAIResults() {
  if (!state.aiResults) {
    aiResults.innerHTML = '';
    return;
  }
  const drafts = state.aiResults.kind === 'draft'
    ? [state.aiResults.value]
    : state.aiResults.value.suggestions;
  const rationale = state.aiResults.kind === 'suggestions'
    ? `<p class="muted">${escapeHtml(state.aiResults.value.rationale)}</p>`
    : '';
  aiResults.innerHTML = `${rationale}<div class="ai-result-grid">${drafts.map((draft, index) => renderDraft(draft, index)).join('')}</div>`;
}

function renderDraft(draft, index) {
  return `
    <article class="ai-result-card">
      <p class="eyebrow">AI TASK DRAFT · P${escapeHtml(draft.priority)}</p>
      <h3>${escapeHtml(draft.title)}</h3>
      <p class="task-description">${escapeHtml(draft.description)}</p>
      <div class="task-meta">
        <span class="badge">${escapeHtml(draft.verificationProfile)}</span>
        ${(draft.allowedPaths || []).map((item) => `<span class="badge mono">${escapeHtml(item)}</span>`).join('')}
      </div>
      ${renderListSection('완료 조건', draft.acceptanceCriteria)}
      ${renderListSection('위험', draft.risks)}
      <button class="primary" type="button" data-ai-draft-index="${index}">작업 폼으로 가져오기</button>
    </article>`;
}

function applyDraftToForm(draft) {
  const form = document.querySelector('#task-form');
  form.elements.title.value = draft.title || '';
  form.elements.description.value = draft.description || '';
  form.elements.priority.value = draft.priority || 100;
  form.elements.allowedPaths.value = (draft.allowedPaths || ['**']).join('\n');
  form.elements.acceptanceCriteria.value = (draft.acceptanceCriteria || []).join('\n');
  if ([...form.elements.verificationProfile.options].some((option) => option.value === draft.verificationProfile)) {
    form.elements.verificationProfile.value = draft.verificationProfile;
  }
  taskFormPanel.classList.remove('hidden');
  aiPanel.classList.add('hidden');
  form.elements.title.focus();
  showToast('AI 초안을 작업 폼에 넣었습니다. 사람이 검토한 뒤 생성하세요.');
}

async function refreshCurrentView(quiet = true) {
  await bootstrap({ quiet: true });
  if (state.activeView === 'harnesses') await loadLearningAudit({ quiet: true });
  if (state.activeView === 'ai-logs') await loadAISessions({ quiet: true });
  if (!quiet) showToast(state.activeView === 'usage' ? '사용량을 갱신했습니다.' : state.activeView === 'harnesses' ? '하네스를 갱신했습니다.' : state.activeView === 'case-wiki' ? 'WIKI를 갱신했습니다.' : state.activeView === 'discussion' ? '대화를 갱신했습니다.' : '최신 상태를 불러왔습니다.');
}

function populateBoardFilters() {
  const assignee = document.querySelector('#board-assignee-filter');
  const reviewer = document.querySelector('#board-reviewer-filter');
  if (!assignee || !reviewer) return;
  assignee.innerHTML = '<option value="">전체 작업자</option>' + state.users.map(userOption).join('');
  reviewer.innerHTML = '<option value="">전체 리뷰어</option>' + state.users.map(userOption).join('');
  assignee.value = state.boardFilter.assigneeUserId;
  reviewer.value = state.boardFilter.reviewerUserId;
}

function switchView(view) {
  state.activeView = ['loop', 'usage', 'board', 'harnesses', 'case-wiki', 'ai-logs', 'discussion'].includes(view) ? view : 'loop';
  loopView.classList.toggle('hidden', state.activeView !== 'loop');
  usageView.classList.toggle('hidden', state.activeView !== 'usage');
  boardView.classList.toggle('hidden', state.activeView !== 'board');
  harnessView.classList.toggle('hidden', state.activeView !== 'harnesses');
  caseWikiView.classList.toggle('hidden', state.activeView !== 'case-wiki');
  discussionView.classList.toggle('hidden', state.activeView !== 'discussion');
  aiLogsView.classList.toggle('hidden', state.activeView !== 'ai-logs');
  for (const button of document.querySelectorAll('[data-view]')) {
    button.classList.toggle('active', button.dataset.view === state.activeView);
  }
}

function renderLearningLoop() {
  const tasks = state.tasks || [];
  const failures = state.failures || [];
  const activeHarnesses = state.harnesses.filter((item) => item.status === 'ACTIVE');
  const activeSkills = state.skills.filter((item) => item.status === 'ACTIVE');
  const learnedIds = new Set([...activeHarnesses, ...activeSkills].flatMap((item) => item.sourceFailureCaseIds || []));
  const verified = tasks.filter((task) => task.verification);
  const passed = verified.filter((task) => task.verification?.passed).length;
  const openFailures = failures.filter((item) => item.status === 'OPEN');
  const learnedFailures = failures.filter((item) => learnedIds.has(item.id));
  const learnedOccurrences = learnedFailures.reduce((sum, item) => sum + Number(item.occurrences || 0), 0);
  const repeatFailures = failures.filter((item) => Number(item.occurrences || 0) > 1).length;
  renderRunModes();
  document.querySelector('#loop-kpis').innerHTML = [
    loopMetric('검증 통과율', verified.length ? formatPercent(passed / verified.length) : '—', `${passed}/${verified.length} 작업`, 'good'),
    loopMetric('열린 실패', formatNumber(openFailures.length), '분류와 승격 필요', openFailures.length ? 'danger' : 'good'),
    loopMetric('학습된 실패', formatNumber(learnedFailures.length), `${formatNumber(learnedOccurrences)}회 관찰 근거`, 'learned'),
    loopMetric('반복 실패', formatNumber(repeatFailures), '재발 방지 대상', repeatFailures ? 'warning' : 'good'),
    loopMetric('활성 방어', formatNumber(activeHarnesses.length + activeSkills.length), `하네스 ${activeHarnesses.length} · 스킬 ${activeSkills.length}`, 'learned'),
  ].join('');
  const queues = [
    ['실행 중', tasks.filter((item) => item.status === 'IN_PROGRESS').length, 'board', '결과를 만들어 검증'],
    ['검증/리뷰', tasks.filter((item) => item.status === 'REVIEW').length, 'board', '사람 승인 대기'],
    ['분류할 실패', openFailures.length, 'harnesses', '원인과 반복성 확인'],
    ['활성화 대기', [...state.harnesses, ...state.skills].filter((item) => item.status === 'DRAFT').length, 'harnesses', '시험 후 승격'],
    ['재발 감시', learnedFailures.length, 'harnesses', '같은 서명 재등장 확인'],
  ];
  document.querySelector('#loop-action-count').textContent = `${queues.reduce((sum, item) => sum + item[1], 0)}건`;
  document.querySelector('#loop-pipeline').innerHTML = queues.map((item, index) => `<button type="button" class="loop-stage" data-loop-view="${item[2]}"><span>${String(index + 1).padStart(2, '0')}</span><strong>${escapeHtml(item[0])}</strong><b>${formatNumber(item[1])}</b><small>${escapeHtml(item[3])}</small></button>`).join('');
  document.querySelector('#loop-failures').innerHTML = openFailures.length ? openFailures.slice(0, 6).map((failure) => {
    const recommendation = failure.kind === 'SCOPE_VIOLATION' ? ['SKILL', '실행 전 작업 규칙으로 예방'] : failure.lastEvidence?.file ? ['HARNESS', '동일 명령으로 재현 가능'] : ['SKILL', '사람 판단이 필요한 절차 문제'];
    return `<article class="loop-failure"><div><span class="badge fail">${escapeHtml(failure.kind)}</span><strong>${escapeHtml(failure.title)}</strong><small>${formatNumber(failure.occurrences)}회 · ${escapeHtml(failure.harnessId || '하네스 없음')}</small></div><div class="loop-recommend"><b>${recommendation[0]} 추천</b><span>${recommendation[1]}</span></div></article>`;
  }).join('') : '<div class="loop-empty-good">열린 실패가 없습니다. 현재 루프가 깨끗합니다.</div>';
  const impact = [...activeSkills.map((item) => ({ ...item, type: 'SKILL' })), ...activeHarnesses.map((item) => ({ ...item, type: 'HARNESS' }))]
    .map((item) => { const cases = failures.filter((failure) => (item.sourceFailureCaseIds || []).includes(failure.id)); return { item, cases, occurrences: cases.reduce((sum, failure) => sum + Number(failure.occurrences || 0), 0) }; })
    .filter((entry) => entry.cases.length).sort((a, b) => b.occurrences - a.occurrences).slice(0, 6);
  document.querySelector('#loop-impact').innerHTML = impact.length ? impact.map(({ item, cases, occurrences }) => `<article class="loop-impact"><span class="badge">${item.type}</span><div><strong>${escapeHtml(item.label)}</strong><small>실패 ${cases.length}종 · ${formatNumber(occurrences)}회 관찰에서 학습</small></div><b>${formatNumber(occurrences)}</b></article>`).join('') : '<div class="empty">실패 사례와 연결된 활성 학습이 아직 없습니다.</div>';
  document.querySelector('#loop-recent').innerHTML = [...tasks].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 6).map((task) => `<article class="loop-work"><div><span class="badge ${task.verification?.passed ? 'pass' : task.verification ? 'fail' : ''}">${task.verification?.passed ? 'VERIFIED' : task.verification ? 'FAILED' : task.status}</span><strong>${escapeHtml(task.title)}</strong></div><p>${task.skillIds?.length || 0}개 스킬 · ${escapeHtml(task.verificationProfile || '하네스 없음')}</p><small>${escapeHtml(formatDateTime(task.updatedAt))}</small></article>`).join('') || '<div class="empty">아직 작업 기록이 없습니다.</div>';
}

function renderRunModes() {
  const results = state.runResults || [];
  const active = state.activeRunScopes || [];
  document.querySelector('#loop-mode-count').textContent = active.length ? `${active.length}개 실행 중` : `${results.length}개 최근 결과`;
  const activeIds = new Set(active.map((item) => item.runId));
  const cards = [
    ...active.map((item) => ({ runId: item.runId, title: item.title || item.runId, verdict: 'RUNNING', mode: item.mode, profile: item.verificationProfile, strength: '진행 중', enabledSkills: [], autoDisabledSkills: [] })),
    ...results.filter((item) => !activeIds.has(item.runId)),
  ].slice(0, 6);
  document.querySelector('#loop-run-modes').innerHTML = cards.length ? cards.map((result) => {
    const mode = result.mode || {};
    const enabled = result.enabledSkills || [];
    const disabled = result.autoDisabledSkills || [];
    return `<article class="loop-mode-card mode-${escapeHtml(String(mode.appliedMode || 'CODE').toLowerCase())}">
      <header><span class="mode-badge">${escapeHtml(mode.appliedMode || 'CODE')}</span><span class="badge ${result.verdict === 'PASSED' ? 'pass' : result.verdict === 'RUNNING' ? '' : 'fail'}">${escapeHtml(result.verdict)}</span></header>
      <strong>${escapeHtml(result.title || result.runId)}</strong>
      <p>${escapeHtml(mode.requestedMode === 'AUTO' ? `AUTO · ${modeReasonLabel(mode.reason)}` : `${mode.requestedMode} · 명시된 모드`)}</p>
      <div class="mode-meta"><span>하네스 <b>${escapeHtml(result.profile || '없음')}</b></span><span>강도 <b>${escapeHtml(result.strength || '—')}</b></span></div>
      ${result.verdict === 'RUNNING' ? '<small>스킬은 실행 문서에서 자동 적용 중</small>' : `<small>ON ${escapeHtml(enabled.join(', ') || '없음')}</small>`}
      ${disabled.length ? `<small>OFF ${escapeHtml(disabled.join(', '))}</small>` : ''}
    </article>`;
  }).join('') : '<div class="empty">모드가 기록된 실행 결과가 아직 없습니다.</div>';
}

function modeReasonLabel(reason) {
  return ({
    'source, test, configuration, or tooling path takes precedence': '소스·테스트·설정·도구 경로를 우선 감지',
    'goal or path indicates divergent idea exploration': '아이디어 발산 목표 또는 경로 감지',
    'document-oriented paths or goal detected': '문서 전용 경로 또는 작성 목표 감지',
    'source or mixed project work detected': '소스 또는 혼합 작업 감지',
    'explicit mode requested': '실행 문서에서 명시',
  })[reason] || reason || '자동 판정';
}

function loopMetric(label, value, caption, tone) { return `<article class="loop-metric tone-${tone}"><p>${escapeHtml(label)}</p><strong>${escapeHtml(value)}</strong><span>${escapeHtml(caption)}</span></article>`; }

async function loadUsage({ quiet = true } = {}) {
  try {
    const payload = await api(`/api/usage?days=${state.usageDays}`);
    state.usage = payload.usage;
    renderUsage();
    if (!quiet) showToast('사용량을 갱신했습니다.');
  } catch (error) {
    if (!quiet) showToast(error.message, true);
  }
}

async function loadAISessions({ quiet = true } = {}) {
  try { const payload = await api('/api/ai-sessions?limit=80'); state.aiSessions = payload.sessions || []; renderAISessionList(); if (!quiet) showToast('AI 세션 목록을 갱신했습니다.'); }
  catch (error) { aiSessionList.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}
async function loadAISession(id) {
  aiSessionDetail.innerHTML = '<div class="empty">세션을 불러오는 중입니다.</div>';
  try { const payload = await api(`/api/ai-sessions/${encodeURIComponent(id)}`); state.selectedAISession = payload.session; renderAISessionList(); renderAISessionDetail(); }
  catch (error) { aiSessionDetail.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}
function renderAISessionList() {
  const query = state.aiSessionQuery.trim().toLowerCase();
  const sessions = state.aiSessions.filter((session) => !query || `${session.title} ${session.cwd}`.toLowerCase().includes(query));
  document.querySelector('#ai-log-count').textContent = `${formatNumber(sessions.length)}개 세션`;
  aiSessionList.innerHTML = sessions.length ? sessions.map((session) => `<button type="button" class="ai-session-item ${state.selectedAISession?.id === session.id ? 'active' : ''}" data-ai-session-id="${escapeHtml(session.id)}"><strong>${escapeHtml(session.title)}</strong><span>${escapeHtml(formatDateTime(session.updatedAt))} · ${formatNumber(session.messageCount)}개 이벤트</span><small class="mono">${escapeHtml(session.cwd || '작업 폴더 없음')}</small></button>`).join('') : '<div class="empty">표시할 세션이 없습니다.</div>';
}
function renderAISessionDetail() {
  const session = state.selectedAISession; if (!session) return;
  const messages = state.aiLogMode === 'answers'
    ? session.messages.filter((message) => message.role === 'user' || (message.role === 'assistant' && message.phase === 'final_answer'))
    : session.messages;
  aiSessionDetail.innerHTML = `<header class="ai-transcript-head"><div><p class="eyebrow">CODEX SESSION</p><h3>${escapeHtml(session.title)}</h3><p class="muted mono">${escapeHtml(session.cwd || '')}</p></div><span class="badge">${formatNumber(messages.length)}개 표시</span></header><div class="ai-transcript">${messages.length ? messages.map(renderAISessionMessage).join('') : '<div class="empty">이 세션에는 최종 답변으로 기록된 메시지가 없습니다. 전체 작업 기록으로 전환해 확인할 수 있습니다.</div>'}</div>`;
}
function renderAISessionMessage(message) {
  const label = message.role === 'user' ? '사용자' : message.role === 'assistant' ? 'AI' : message.kind === 'output' ? `${message.toolName} 결과` : `${message.toolName} 호출`;
  const body = message.role === 'tool' ? `<pre>${escapeHtml(message.content)}</pre>${message.truncated ? '<small>긴 출력이 잘렸습니다.</small>' : ''}` : `<p>${escapeHtml(message.content)}</p>`;
  return `<article class="ai-log-message role-${escapeHtml(message.role)} kind-${escapeHtml(message.kind || 'message')}"><div class="ai-log-message-head"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(formatDateTime(message.at))}</span></div>${body}</article>`;
}

async function loadLearningAudit({ quiet = true } = {}) {
  try {
    const payload = await api('/api/learning/audit');
    state.learningAudit = payload.audit;
    if (!quiet) showToast('Learning audit refreshed.');
  } catch (error) {
    if (!quiet) showToast(error.message, true);
  }
}

function renderUsage() {
  const usage = state.usage;
  if (!usage) return;
  const externalPrimary = usage.totals.requests === 0 && usage.external?.totals?.totalTokens > 0;
  document.querySelector('#usage-scope').textContent = externalPrimary
    ? 'OpenAI API 없이 로컬 Codex/Claude CLI 사용량과 잔여 한도를 메인 지표로 표시합니다.'
    : usage.scope.description;
  document.querySelector('#usage-period-label').textContent = `${usage.period.days}일 · ${usage.period.timeZone}`;
  document.querySelector('#usage-updated').textContent = `${formatDateTime(usage.generatedAt)} 갱신`;

  if (externalPrimary) renderExternalPrimaryUsage(usage);
  else renderServerPrimaryUsage(usage);

  renderExternalUsage(usage.external);
}

function renderServerPrimaryUsage(usage) {
  const totals = usage.totals;
  document.querySelector('#usage-kpis').innerHTML = [
    kpiCard('캐시 제외 토큰', formatTokens(totals.totalTokens), `${formatNumber(totals.requests)}회 요청`, 'token'),
    kpiCard('입력 토큰', formatTokens(totals.inputTokens), `캐시 ${formatTokens(totals.inputCachedTokens)}`, 'input'),
    kpiCard('출력 토큰', formatTokens(totals.outputTokens), `추론 ${formatTokens(totals.reasoningTokens)}`, 'output'),
    kpiCard('실패율', formatPercent(totals.failureRate), `${formatNumber(totals.failedRequests)}회 실패`, totals.failedRequests ? 'danger' : 'ok'),
    kpiCard('평균 응답', formatDuration(totals.averageDurationMs), `${formatNumber(totals.successfulRequests)}회 성공`, 'latency'),
    kpiCard('추정 비용', formatCost(totals), pricingCaption(totals), 'cost'),
  ].join('');

  document.querySelector('#usage-budgets').innerHTML = [
    budgetCard('월간 토큰', usage.budget.tokens, formatTokens),
    budgetCard('월간 요청', usage.budget.requests, formatNumber),
    budgetCard('월간 비용', usage.budget.costUsd, (value) => `$${Number(value || 0).toFixed(2)}`),
  ].join('');

  document.querySelector('#usage-budgets').insertAdjacentHTML('beforeend', weeklyQuotaCards(usage.external).join(''));
  renderUsageAlert(usage);
  renderUsageChart(usage.daily);
  renderRankList('#usage-sources', usage.bySource, 'source', sourceLabel);
  renderRankList('#usage-features', usage.byFeature, 'feature', featureLabel);
  renderRankList('#usage-models', usage.byModel, 'model', (value) => value);
  renderUsageUsers(usage.byUser);
  renderRecentUsage(usage.recent);
}

function renderExternalPrimaryUsage(usage) {
  const external = usage.external;
  const totals = external.totals;
  const quota = firstExternalQuota(external);
  document.querySelector('#usage-kpis').innerHTML = [
    kpiCard('CLI 캐시 제외', formatTokens(totals.totalTokens), `${formatNumber(totals.windows)}개 수집 창`, 'token'),
    kpiCard('CLI 입력 토큰', formatTokens(totals.inputTokens), `캐시 ${formatTokens(totals.inputCachedTokens)}`, 'input'),
    kpiCard('CLI 캐시 절약', formatTokens(totals.inputCachedTokens), `${formatPercent(cacheRate(totals))} 입력 캐시`, 'ok'),
    kpiCard('CLI 출력 토큰', formatTokens(totals.outputTokens), `추론 ${formatTokens(totals.reasoningTokens)}`, 'output'),
    kpiCard('주간 할당량', quota ? `${externalQuotaPercent(quota)}%` : '없음', quota ? `${quota.toolLabel} · ${quota.label}` : 'usage push 필요', quota ? quotaTone(quota) : 'latency'),
    kpiCard('연결 도구', formatNumber(external.byTool.length), external.byTool.map((item) => externalToolLabel(item.tool)).join(', ') || '없음', 'latency'),
    kpiCard('API 비용', '미사용', 'OpenAI API 키 없음', 'cost'),
  ].join('');

  document.querySelector('#usage-budgets').innerHTML = [
    `<article class="budget-card unconfigured"><div><p>서버 API 모드</p><strong>꺼짐</strong></div><p class="muted">현재 화면은 로컬 CLI 사용량을 보여줍니다.</p></article>`,
    `<article class="budget-card unconfigured"><div><p>Codex 주간 한도</p><strong>${quota ? `${externalQuotaPercent(quota)}% 사용` : '없음'}</strong></div><p class="muted">${quota?.resetsAt ? `리셋 ${formatDateTime(quota.resetsAt)}` : 'team-loop usage push로 갱신하세요.'}</p></article>`,
    `<article class="budget-card unconfigured"><div><p>수집 범위</p><strong>외부 도구</strong></div><p class="muted">서버 예산에는 합산하지 않는 참고 집계입니다.</p></article>`,
  ].join('');

  document.querySelector('#usage-budgets').innerHTML = [
    `<article class="budget-card unconfigured"><div><p>서버 API 모드</p><strong>꺼짐</strong></div><p class="muted">현재 화면은 로컬 CLI 사용량과 할당량을 보여줍니다.</p></article>`,
    ...weeklyQuotaCards(external),
    `<article class="budget-card unconfigured"><div><p>집계 범위</p><strong>외부 도구</strong></div><p class="muted">서버 예산에는 합산하지 않는 참고 지표입니다.</p></article>`,
  ].join('');
  renderUsageAlert({ ...usage, budget: { tokens: { status: 'UNCONFIGURED' }, requests: { status: 'UNCONFIGURED' }, costUsd: { status: 'UNCONFIGURED' } } });
  renderUsageChart(external.daily || []);
  renderExternalRankList('#usage-sources', external.byTool, 'tool', externalToolLabel);
  renderExternalRankList('#usage-models', external.byModel, 'model', (value) => value);
  renderExternalPrimaryUsers(external.byUser);
  document.querySelector('#usage-features').innerHTML = '<div class="empty">서버 AI 기능을 쓰지 않는 CLI 모드입니다.</div>';
  document.querySelector('#usage-recent').innerHTML = '<div class="empty">서버 API 호출 기록은 없습니다. CLI 사용량은 위 지표와 외부 도구 토큰에 집계됩니다.</div>';
}

function firstExternalQuota(external) {
  return primaryExternalQuota(external);
}

function primaryExternalQuota(external) {
  const weekly = weeklyQuotaWindows(external);
  return weekly.find((quota) => quota.tool === 'codex')
    || weekly.find((quota) => quota.tool === 'claude-code')
    || externalQuotaWindows(external)[0]
    || null;
}

function externalQuotaWindows(external) {
  return (external?.quota || []).flatMap((entry) => (entry.windows || []).map((window) => ({
    ...window,
    tool: entry.tool,
    toolLabel: externalToolLabel(entry.tool),
    actorName: entry.actorName,
    source: entry.source,
  })));
}

function weeklyQuotaWindows(external) {
  return externalQuotaWindows(external)
    .filter((window) => Number(window.windowDurationMinutes) >= 7 * 24 * 60 || /week|7|seven/i.test(`${window.windowId} ${window.label}`))
    .sort((a, b) => (a.tool === 'codex' ? -1 : b.tool === 'codex' ? 1 : a.toolLabel.localeCompare(b.toolLabel)));
}

function weeklyQuotaCards(external) {
  const weekly = weeklyQuotaWindows(external);
  if (!weekly.length) {
    return [`<article class="budget-card unconfigured"><div><p>주간 할당량</p><strong>없음</strong></div><p class="muted">team-loop usage push를 실행하면 Codex/Claude 주간 한도가 표시됩니다.</p></article>`];
  }
  return weekly.map((quota) => {
    const used = Number(quota.effectiveUsedPercent ?? quota.usedPercent) || 0;
    const remaining = Math.max(0, 100 - used);
    const reset = quota.resetsAt ? `리셋 ${formatDateTime(quota.resetsAt)}` : '리셋 시각 없음';
    return `<article class="budget-card status-${quotaStatus(quota)}">
      <div class="budget-top"><div><p>${escapeHtml(`${quota.toolLabel} 주간 할당량`)}</p><strong>${escapeHtml(`${used.toFixed(1)}% 사용`)}</strong></div><span>${escapeHtml(`${remaining.toFixed(1)}% 남음`)}</span></div>
      <div class="progress"><i style="width:${Math.min(100, Math.max(0, used))}%"></i></div>
      <p class="muted">${escapeHtml(`${quota.label} · ${reset}`)}</p>
    </article>`;
  });
}

function externalQuotaPercent(quota) {
  return Number(quota.effectiveUsedPercent ?? quota.usedPercent ?? 0).toFixed(1);
}

function quotaStatus(quota) {
  const used = Number(quota.effectiveUsedPercent ?? quota.usedPercent) || 0;
  if (used >= 100) return 'exceeded';
  if (used >= 85) return 'critical';
  if (used >= 65) return 'warning';
  return 'ok';
}

function quotaTone(quota) {
  const status = quotaStatus(quota);
  return ['exceeded', 'critical'].includes(status) ? 'danger' : 'ok';
}

function renderExternalPrimaryUsers(users) {
  const target = document.querySelector('#usage-users');
  if (!users.length) {
    target.innerHTML = '<div class="empty">아직 사용자별 CLI 사용량 기록이 없습니다.</div>';
    return;
  }
  target.innerHTML = `<table><thead><tr><th>사용자</th><th>윈도우</th><th>입력</th><th>캐시</th><th>출력</th><th>캐시 제외</th></tr></thead><tbody>${users.map((item) => `<tr><td><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.role || '')}</small></td><td>${formatNumber(item.windows)}</td><td>${formatTokens(item.inputTokens)}</td><td>${formatTokens(item.inputCachedTokens)}</td><td>${formatTokens(item.outputTokens)}</td><td>${formatTokens(item.totalTokens)}</td></tr>`).join('')}</tbody></table>`;
}

function renderExternalUsage(external) {
  const quotaTarget = document.querySelector('#external-quota');
  const toolTarget = document.querySelector('#external-tools');
  const userTarget = document.querySelector('#external-users');
  const modelTarget = document.querySelector('#external-models');
  if (!external) return;

  if (!external.quota.length) {
    quotaTarget.innerHTML = '<div class="empty">`team-loop usage push`를 cron 또는 작업 스케줄러에 등록하면 표시됩니다.</div>';
  } else {
    quotaTarget.innerHTML = external.quota.map((entry) => `<article class="quota-owner-card">
      <div class="quota-owner-heading"><strong>${escapeHtml(entry.actorName)}</strong><span class="badge">${escapeHtml(externalToolLabel(entry.tool))}</span></div>
      ${entry.windows.map((window) => quotaWindow(entry, window)).join('')}
    </article>`).join('');
  }

  renderExternalRankList('#external-tools', external.byTool, 'tool', externalToolLabel);
  renderExternalRankList('#external-models', external.byModel, 'model', (value) => value);
  if (!external.byUser.length) {
    userTarget.innerHTML = '<div class="empty">외부 토큰 기록이 없습니다.</div>';
  } else {
    userTarget.innerHTML = `<table><thead><tr><th>사용자</th><th>윈도우</th><th>입력</th><th>캐시</th><th>출력</th><th>캐시 제외</th></tr></thead><tbody>${external.byUser.map((item) => `<tr><td><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.role || '')}</small></td><td>${formatNumber(item.windows)}</td><td>${formatTokens(item.inputTokens)}</td><td>${formatTokens(item.inputCachedTokens)}</td><td>${formatTokens(item.outputTokens)}</td><td>${formatTokens(item.totalTokens)}</td></tr>`).join('')}</tbody></table>`;
  }
}

function renderExternalRankList(selector, values, key, labeler) {
  const target = document.querySelector(selector);
  if (!values.length) {
    target.innerHTML = '<div class="empty">외부 토큰 기록이 없습니다.</div>';
    return;
  }
  const max = Math.max(1, ...values.map((item) => item.totalTokens));
  target.innerHTML = values.slice(0, 10).map((item) => `<div class="rank-item">
    <div class="rank-copy"><strong>${escapeHtml(labeler(item[key]))}</strong><span>${escapeHtml(externalRankCaption(item))}</span></div>
    <div class="mini-progress"><i style="width:${Math.round(item.totalTokens / max * 100)}%"></i></div>
  </div>`).join('');
}

function externalRankCaption(item) {
  const parts = [`${formatNumber(item.windows)}개 창`, formatTokens(item.totalTokens)];
  if (item.inputCachedTokens) parts.push(`캐시 ${formatTokens(item.inputCachedTokens)}`);
  return parts.join(' · ');
}

function cacheRate(item) {
  return item.inputTokens ? item.inputCachedTokens / item.inputTokens : 0;
}

function quotaWindow(entry, window) {
  const used = Number(window.effectiveUsedPercent ?? window.usedPercent) || 0;
  const freshness = window.freshness || 'STALE';
  const badge = freshness === 'LIVE'
    ? '실시간'
    : freshness === 'RESET_INFERRED'
      ? `리셋 추정 · 마지막 확인 ${Number(window.lastKnownUsedPercent || 0).toFixed(1)}%`
      : `마지막 확인 ${formatNumber(window.staleSinceMinutes)}분 전`;
  const reset = window.resetsAt ? ` · 리셋 ${formatDateTime(window.resetsAt)}` : '';
  return `<div class="quota-window freshness-${escapeHtml(freshness.toLowerCase())}">
    <div><span>${escapeHtml(window.label)}</span><strong>${escapeHtml(`${used.toFixed(1)}%`)}</strong></div>
    <div class="progress"><i style="width:${Math.min(100, Math.max(0, used))}%"></i></div>
    <small>${escapeHtml(badge + reset)}</small>
  </div>`;
}

function externalToolLabel(value) {
  return ({ 'claude-code': 'Claude Code', codex: 'Codex', other: '기타' })[value] || value;
}

function kpiCard(label, value, caption, tone) {
  return `<article class="kpi-card tone-${escapeHtml(tone)}"><p>${escapeHtml(label)}</p><strong>${escapeHtml(value)}</strong><span>${escapeHtml(caption)}</span></article>`;
}

function budgetCard(label, metric, formatter) {
  if (!metric.configured) {
    return `<article class="budget-card unconfigured"><div><p>${escapeHtml(label)}</p><strong>설정 안 됨</strong></div><p class="muted">config/usage-dashboard.json 또는 환경 변수에서 한도를 설정하세요.</p></article>`;
  }
  const width = Math.min(100, Math.max(0, metric.percent));
  return `<article class="budget-card status-${metric.status.toLowerCase()}">
    <div class="budget-top"><div><p>${escapeHtml(label)}</p><strong>${escapeHtml(formatter(metric.used))} / ${escapeHtml(formatter(metric.limit))}</strong></div><span>${escapeHtml(`${metric.percent}%`)}</span></div>
    <div class="progress"><i style="width:${width}%"></i></div>
    <p class="muted">남음 ${escapeHtml(formatter(metric.remaining))}</p>
  </article>`;
}

function renderUsageAlert(usage) {
  const alert = document.querySelector('#usage-alert');
  const metrics = [usage.budget.tokens, usage.budget.requests, usage.budget.costUsd];
  const critical = metrics.find((item) => ['EXCEEDED', 'CRITICAL'].includes(item.status));
  const warning = metrics.find((item) => item.status === 'WARNING');
  if (critical) {
    alert.textContent = critical.status === 'EXCEEDED' ? '설정한 월간 할당량을 초과했습니다.' : '월간 할당량의 85% 이상을 사용했습니다.';
    alert.className = 'notice danger-notice';
  } else if (warning) {
    alert.textContent = '월간 할당량의 65% 이상을 사용했습니다.';
    alert.className = 'notice';
  } else {
    alert.className = 'notice hidden';
    alert.textContent = '';
  }
}

function renderUsageChart(daily) {
  const chart = document.querySelector('#usage-chart');
  const visible = daily.length > 31 ? daily.filter((_item, index) => index % 3 === 0 || index === daily.length - 1) : daily;
  const max = Math.max(1, ...visible.map((item) => item.totalTokens));
  chart.innerHTML = visible.map((item) => {
    const inputHeight = Math.max(item.inputTokens ? 3 : 0, Math.round(item.inputTokens / max * 100));
    const outputHeight = Math.max(item.outputTokens ? 3 : 0, Math.round(item.outputTokens / max * 100));
    return `<div class="chart-day" title="${escapeHtml(item.date)} · ${formatNumber(item.totalTokens)} tokens">
      <div class="bar-stack"><i class="bar-output" style="height:${outputHeight}%"></i><i class="bar-input" style="height:${inputHeight}%"></i></div>
      <span>${escapeHtml(item.date.slice(5))}</span>
    </div>`;
  }).join('');
}

function renderRankList(selector, values, key, labeler) {
  const target = document.querySelector(selector);
  if (!values.length) {
    target.innerHTML = '<div class="empty">아직 사용 기록이 없습니다.</div>';
    return;
  }
  const max = Math.max(1, ...values.map((item) => item.totalTokens));
  target.innerHTML = values.slice(0, 10).map((item) => `<div class="rank-item">
    <div class="rank-copy"><strong>${escapeHtml(labeler(item[key]))}</strong><span>${formatNumber(item.requests)}회 · ${formatTokens(item.totalTokens)}</span></div>
    <div class="mini-progress"><i style="width:${Math.round(item.totalTokens / max * 100)}%"></i></div>
  </div>`).join('');
}

function renderUsageUsers(users) {
  const target = document.querySelector('#usage-users');
  if (!users.length) {
    target.innerHTML = '<div class="empty">아직 사용자별 기록이 없습니다.</div>';
    return;
  }
  target.innerHTML = `<table><thead><tr><th>사용자</th><th>요청</th><th>입력</th><th>출력</th><th>캐시 제외</th><th>비중</th></tr></thead><tbody>${users.map((item) => {
    const share = state.usage.totals.totalTokens ? item.totalTokens / state.usage.totals.totalTokens : 0;
    return `<tr><td><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.role || '')}</small></td><td>${formatNumber(item.requests)}</td><td>${formatTokens(item.inputTokens)}</td><td>${formatTokens(item.outputTokens)}</td><td>${formatTokens(item.totalTokens)}</td><td>${formatPercent(share)}</td></tr>`;
  }).join('')}</tbody></table>`;
}

function renderRecentUsage(events) {
  const target = document.querySelector('#usage-recent');
  if (!events.length) {
    target.innerHTML = '<div class="empty">AI를 사용하면 여기에 호출 기록이 나타납니다.</div>';
    return;
  }
  target.innerHTML = `<table><thead><tr><th>시각</th><th>사용자</th><th>출처</th><th>기능</th><th>모델</th><th>토큰</th><th>상태</th><th>응답</th></tr></thead><tbody>${events.map((event) => `<tr>
    <td>${escapeHtml(formatDateTime(event.at))}</td><td>${escapeHtml(event.actorName)}</td><td><span class="badge">${escapeHtml(sourceLabel(event.source))}</span></td><td>${escapeHtml(featureLabel(event.feature))}</td><td class="mono">${escapeHtml(event.model)}</td><td>${formatTokens(event.usage?.totalTokens || 0)}</td><td><span class="badge ${event.status === 'SUCCESS' ? 'pass' : 'fail'}">${escapeHtml(event.status)}</span></td><td>${escapeHtml(formatDuration(event.durationMs))}</td>
  </tr>`).join('')}</tbody></table>`;
}

function sourceLabel(value) {
  return ({ cli: '개인 CLI', web: '웹', api: '직접 API' })[value] || value;
}

function featureLabel(value) {
  return ({
    'task-draft': '작업 초안',
    'next-tasks': '다음 작업 제안',
    'task-brief': '작업 브리프',
    'verification-summary': '검증 요약',
  })[value] || value;
}

function formatTokens(value) {
  const number = Number(value) || 0;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 1 : 2)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(number >= 100_000 ? 0 : 1)}k`;
  return formatNumber(number);
}

function formatNumber(value) {
  return new Intl.NumberFormat('ko-KR').format(Number(value) || 0);
}

function formatPercent(value) {
  return `${((Number(value) || 0) * 100).toFixed(1)}%`;
}

function formatDuration(value) {
  const ms = Number(value) || 0;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}분`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}초`;
  return `${Math.round(ms)}ms`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

function relativeTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return '방금';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return formatDateTime(value);
}

function formatCost(totals) {
  if (!totals.pricedRequests) return '가격 미설정';
  return `$${Number(totals.estimatedCostUsd || 0).toFixed(4)}`;
}

function pricingCaption(totals) {
  if (!totals.pricedRequests) return '모델 가격표 필요';
  return `${formatNumber(totals.pricedRequests)}/${formatNumber(totals.requests)}회 산정`;
}

function renderHarnessDashboard() {
  if (!document.querySelector('#harness-summary')) return;
  const summary = state.failureSummary || {};
  const active = state.harnesses.filter((item) => item.status === 'ACTIVE').length;
  const draft = state.harnesses.filter((item) => item.status === 'DRAFT').length;
  const activeSkills = state.skills.filter((item) => item.status === 'ACTIVE').length;
  document.querySelector('#harness-summary').innerHTML = [
    kpiCard('활성 하네스', formatNumber(active), `${formatNumber(state.harnesses.length)}개 등록`, 'ok'),
    kpiCard('DRAFT', formatNumber(draft), '시험 후 활성화', draft ? 'input' : 'ok'),
    kpiCard('열린 사례', formatNumber(summary.open), `${formatNumber(summary.occurrences)}회 관찰`, summary.open ? 'danger' : 'ok'),
    kpiCard('Fixture 후보', formatNumber(summary.fixtureCandidates), '재현 setup 필요', 'output'),
    kpiCard('활성 스킬', formatNumber(activeSkills), `${formatNumber(state.skills.length)}개 등록`, 'ok'),
  ].join('');
  renderLearningArchivePanel();
  const admin = state.user?.role === 'admin';
  document.querySelector('#learning-create-toggle').classList.toggle('hidden', !admin);
  document.querySelector('#harness-create-toggle').classList.toggle('hidden', !admin);
  document.querySelector('#learning-create-toggle').classList.toggle('active', state.showLearningCreate);
  document.querySelector('#harness-create-toggle').classList.toggle('active', state.showHarnessCreate);
  document.querySelector('#harness-create-panel').classList.toggle('hidden', !admin || !state.showHarnessCreate);
  document.querySelector('#learning-create-panel').classList.toggle('hidden', !admin || !state.showLearningCreate);
  document.querySelector('#harness-count').textContent = `${state.harnesses.length}개`;
  document.querySelector('#skill-count').textContent = `${state.skills.length}개`;
  document.querySelector('#failure-count').textContent = `${summary.total || 0}사례 · ${summary.occurrences || 0}회`;
  const harnesses = [...state.harnesses].sort(artifactSort);
  const skills = [...state.skills].sort(artifactSort);
  harnessList.innerHTML = harnesses.length ? harnesses.map(renderHarnessCard).join('') : '<div class="empty">등록된 하네스가 없습니다.</div>';
  skillList.innerHTML = skills.length ? skills.map(renderSkillCard).join('') : '<div class="empty">등록된 스킬이 없습니다.</div>';
  populateLearningApplyForm();

  const selectedStatus = document.querySelector('#failure-status-filter').value;
  const failures = state.failures.filter((item) => !selectedStatus || item.status === selectedStatus);
  const groups = groupFailureCases(failures);
  failureList.innerHTML = groups.length ? `<table><thead><tr><th>상태</th><th>종류</th><th>하네스</th><th>사례</th><th>관찰</th><th>마지막</th><th>대상</th><th>행동</th></tr></thead><tbody>${groups.map(renderFailureGroupRow).join('')}</tbody></table>` : '<div class="empty">조건에 맞는 사례가 없습니다.</div>';
}

function renderLearningAuditPanel() {
  if (!learningAuditPanel) return;
  const audit = state.learningAudit;
  if (!audit) {
    learningAuditPanel.innerHTML = '<div class="card-heading"><div><p class="eyebrow">LEARNING AUDIT</p><h3>정리 제안</h3><p class="muted">현재 하네스와 스킬을 분석합니다. 이 단계에서는 아무것도 변경하지 않습니다.</p></div><button class="ghost compact" data-learning-audit-action="refresh" type="button">다시 분석</button></div>';
    return;
  }
  const admin = state.user?.role === 'admin';
  const findings = [...(audit.harnesses || []), ...(audit.skills || [])].filter((item) => item.category !== 'KEEP');
  const actions = audit.actions || [];
  learningAuditPanel.innerHTML = `
    <div class="card-heading">
      <div>
        <p class="eyebrow">LEARNING AUDIT</p>
        <h3>정리 제안</h3>
        <p class="muted">분석 결과만 표시 중입니다. 정리 적용을 누르기 전에는 하네스나 스킬 상태가 바뀌지 않습니다.</p>
      </div>
      <div class="inline-actions">
        <button class="ghost compact" data-learning-audit-action="refresh" type="button">다시 분석</button>
        ${admin ? `<button class="warning compact" data-learning-audit-action="apply-cleanup" type="button" ${actions.length ? '' : 'disabled'}>정리 적용 ${formatNumber(actions.length)}</button>` : ''}
      </div>
    </div>
    <div class="audit-summary-grid">
      <div><strong>${formatNumber(audit.summary.keep)}</strong><span>계속 표시</span></div>
      <div><strong>${formatNumber(audit.summary.conditional)}</strong><span>상황별 사용</span></div>
      <div><strong>${formatNumber(audit.summary.cleanup)}</strong><span>정리 후보</span></div>
      <div><strong>${formatNumber(actions.length)}</strong><span>적용 예정</span></div>
    </div>
    ${actions.length ? `<div class="notice audit-apply-note">정리 적용 시 아래 적용 예정 항목만 DISABLED 상태가 됩니다. CONDITIONAL 항목은 숨김 제안일 뿐 자동 비활성화하지 않습니다.</div>` : '<div class="notice audit-apply-note">자동 비활성화할 항목은 없습니다.</div>'}
    ${findings.length ? `<div class="audit-list">${findings.slice(0, 10).map(renderLearningAuditFinding).join('')}</div>` : '<div class="empty">정리 신호가 없습니다.</div>'}
  `;
}

function renderLearningAuditFinding(item) {
  const scheduled = item.action === 'DISABLE' ? '적용 예정' : item.action === 'HIDE_BY_DEFAULT' ? '숨김 제안' : item.action;
  return `<div class="audit-finding audit-${escapeHtml(String(item.category).toLowerCase())}">
    <span class="badge">${escapeHtml(item.category)}</span>
    <strong>${escapeHtml(item.label)}</strong>
    <span class="mono muted">${escapeHtml(item.id)}</span>
    <small>${escapeHtml(scheduled)} · ${escapeHtml(item.reasons?.[0] || '')}</small>
  </div>`;
}

function renderLearningArchivePanel() {
  if (!learningAuditPanel) return;
  const audit = state.learningAudit;
  if (!audit) {
    learningAuditPanel.innerHTML = '<div class="card-heading"><div><p class="eyebrow">LEARNING AUDIT</p><h3>Archive suggestions</h3><p class="muted">Analyze harnesses and skills. Nothing changes until archive is applied.</p></div><button class="ghost compact" data-learning-audit-action="refresh" type="button">Analyze</button></div>';
    return;
  }
  const admin = state.user?.role === 'admin';
  const findings = [...(audit.harnesses || []), ...(audit.skills || [])].filter((item) => item.category !== 'KEEP');
  const actions = audit.actions || [];
  learningAuditPanel.innerHTML = `
    <div class="card-heading">
      <div><p class="eyebrow">LEARNING AUDIT</p><h3>Archive suggestions</h3><p class="muted">Analysis only. Cleanup items move to ARCHIVED, not delete. Conditional items stay available.</p></div>
      <div class="inline-actions">
        <button class="ghost compact" data-learning-audit-action="refresh" type="button">Analyze</button>
        ${admin ? `<button class="warning compact" data-learning-audit-action="apply-cleanup" type="button" ${actions.length ? '' : 'disabled'}>Archive cleanup ${formatNumber(actions.length)}</button>` : ''}
      </div>
    </div>
    <div class="audit-summary-grid">
      <div><strong>${formatNumber(audit.summary.keep)}</strong><span>keep</span></div>
      <div><strong>${formatNumber(audit.summary.conditional)}</strong><span>conditional</span></div>
      <div><strong>${formatNumber(audit.summary.cleanup)}</strong><span>cleanup</span></div>
      <div><strong>${formatNumber(actions.length)}</strong><span>archive ready</span></div>
    </div>
    ${actions.length ? '<div class="notice audit-apply-note">Archive cleanup moves only listed cleanup items to ARCHIVED. You can still inspect them in WIKI.</div>' : '<div class="notice audit-apply-note">No cleanup items are waiting for archive.</div>'}
    ${findings.length ? `<div class="audit-list">${findings.slice(0, 10).map(renderLearningArchiveFinding).join('')}</div>` : '<div class="empty">No cleanup signals.</div>'}
  `;
}

function renderLearningArchiveFinding(item) {
  const scheduled = item.action === 'ARCHIVE' ? 'archive ready' : item.action === 'HIDE_BY_DEFAULT' ? 'hide suggestion' : item.action;
  return `<div class="audit-finding audit-${escapeHtml(String(item.category).toLowerCase())}">
    <span class="badge">${escapeHtml(item.category)}</span>
    <strong>${escapeHtml(item.label)}</strong>
    <span class="mono muted">${escapeHtml(item.id)}</span>
    <small>${escapeHtml(scheduled)} · ${escapeHtml(item.reasons?.[0] || '')}</small>
  </div>`;
}

function renderCaseArchive() {
  renderWikiContextPack();
  renderWikiProjectHistory();
  renderWikiDiscussionMemories();
  renderWikiJudgingCriteria();
  if (!caseArchive) return;
  const archived = state.failures.filter((item) => ['RESOLVED', 'IGNORED'].includes(item.status));
  const groups = groupFailureCases(archived);
  const wikiEntries = groups.length
    + (String(state.projectContext?.content || '').trim() ? 1 : 0)
    + (timelineEvents().length ? 1 : 0)
    + (state.discussions?.memories?.length || 0)
    + judgingCriteria.length;
  document.querySelector('#case-archive-count').textContent = `${formatNumber(wikiEntries)}개 항목`;
  caseArchive.innerHTML = groups.length
    ? groups.map(renderCaseArchiveCard).join('')
    : '<div class="empty">아직 아카이브된 사례가 없습니다.</div>';
}

function renderCaseArchiveCard(group) {
  const failure = group.representative;
  const artifacts = group.cases.flatMap((item) => item.learningArtifacts || []);
  const artifactBadges = artifacts.length
    ? [...new Map(artifacts.map((item) => [`${item.type}:${item.id}`, item])).values()]
      .map((item) => `<span class="badge">${escapeHtml(item.type)} ${escapeHtml(item.id)}</span>`).join('')
    : '<span class="badge">연결 아티팩트 없음</span>';
  return `<details class="case-archive-item">
    <summary class="case-archive-summary">
      <span class="badge ${group.status === 'RESOLVED' ? 'pass' : ''}">${escapeHtml(group.status)}</span>
      <strong>${escapeHtml(failure.title || group.kind)}</strong>
      <span class="muted">${escapeHtml(group.kind)}</span>
      <span class="badge">사례 ${formatNumber(group.cases.length)}</span>
      <span class="badge">관찰 ${formatNumber(group.occurrences)}</span>
      <span class="badge">마지막 ${escapeHtml(formatDateTime(group.lastSeenAt))}</span>
    </summary>
    <div class="case-archive-body">
      <div class="case-archive-head"><span class="mono muted">${escapeHtml(group.harnessId)}</span></div>
      <div class="task-meta">${artifactBadges}</div>
      <details class="details"><summary>대표 증거</summary><pre>${escapeHtml(JSON.stringify(failure.lastEvidence, null, 2))}</pre></details>
    </div>
  </details>`;
}

function renderWikiContextPack() {
  if (!wikiContextPack) return;
  const content = String(state.projectContext?.content || '').trim();
  const updated = state.projectContext?.updatedAt ? formatDateTime(state.projectContext.updatedAt) : '아직 저장 없음';
  if (!content) {
    wikiContextPack.innerHTML = '<div class="empty">아직 저장된 프로젝트 컨텍스트가 없습니다. 작업 보드의 AI 도우미에서 먼저 컨텍스트를 저장할 수 있습니다.</div>';
    return;
  }
  const preview = content.length > 900 ? `${content.slice(0, 900)}...` : content;
  wikiContextPack.innerHTML = `<details class="wiki-entry">
    <summary><strong>현재 컨텍스트 팩</strong><span class="badge">${escapeHtml(updated)}</span></summary>
    <pre>${escapeHtml(preview)}</pre>
  </details>`;
}

function renderWikiProjectHistory() {
  if (!wikiProjectHistory) return;
  const events = timelineEvents()
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 12);
  wikiProjectHistory.innerHTML = events.length
    ? events.map(renderWikiHistoryItem).join('')
    : '<div class="empty">아직 보여줄 프로젝트 히스토리가 없습니다.</div>';
}

function renderWikiHistoryItem(event) {
  const task = state.tasks.find((item) => item.id === event.taskId);
  return `<details class="wiki-entry">
    <summary><strong>${escapeHtml(event.title)}</strong><span class="badge">${escapeHtml(categoryLabel(event.category))}</span><span class="muted">${escapeHtml(formatDateTime(event.at))}</span></summary>
    <p>${escapeHtml(task?.description || event.note || '설명 없음')}</p>
    <div class="task-meta"><span class="badge">${escapeHtml(task?.status || 'TASK')}</span>${event.actorUserId ? `<span class="badge">${escapeHtml(userName(event.actorUserId))}</span>` : ''}</div>
  </details>`;
}

function renderWikiDiscussionMemories() {
  if (!wikiDiscussionMemories) return;
  const memories = [...(state.discussions?.memories || [])].reverse().slice(0, 8);
  wikiDiscussionMemories.innerHTML = memories.length
    ? memories.map(renderDiscussionMemory).join('')
    : '<div class="empty">아직 대화창에서 저장한 회의록이 없습니다.</div>';
}

function renderWikiJudgingCriteria() {
  if (!wikiJudgingCriteria) return;
  wikiJudgingCriteria.innerHTML = judgingCriteria.map((item) => `<details class="wiki-entry judging-entry">
    <summary><strong>${item.no}. ${escapeHtml(item.title)}</strong><span class="badge">${escapeHtml(item.grade)}</span><span class="badge">${escapeHtml(item.lane)}</span></summary>
    <p>${escapeHtml(item.summary)}</p>
    <div class="task-meta"><span class="badge mono">${escapeHtml(item.artifact)}</span></div>
  </details>`).join('');
}

function renderDiscussionBoard() {
  if (!discussionMessages) return;
  const messages = state.discussions?.messages || [];
  document.querySelector('#discussion-count').textContent = `${formatNumber(messages.length)}개 메시지`;
  discussionMessages.innerHTML = messages.length
    ? messages.map(renderDiscussionMessage).join('')
    : '<div class="empty">아직 대화가 없습니다.</div>';
}

function renderDiscussionMessage(message) {
  return `<article class="discussion-message">
    <div class="discussion-message-head"><strong>${escapeHtml(userName(message.authorUserId) || '알 수 없음')}</strong><span class="muted">${escapeHtml(formatDateTime(message.createdAt))}</span></div>
    <p>${escapeHtml(message.content)}</p>
  </article>`;
}

function renderDiscussionMemory(memory) {
  const aiBadge = memory.ai?.fallback ? '<span class="badge">fallback</span>' : memory.ai?.model ? `<span class="badge">${escapeHtml(memory.ai.model)}</span>` : '';
  return `<details class="wiki-entry">
    <summary><strong>${escapeHtml(memory.title)}</strong><span class="badge">${escapeHtml(formatDateTime(memory.createdAt))}</span>${aiBadge}</summary>
    <p>${escapeHtml(memory.summary)}</p>
    ${memory.keyPoints?.length ? `<div class="task-meta">${memory.keyPoints.map((item) => `<span class="badge">${escapeHtml(item)}</span>`).join('')}</div>` : ''}
    ${memory.decisions?.length ? `<h4>결정</h4><ul class="case-id-list">${memory.decisions.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
    ${memory.followUps?.length ? `<h4>후속</h4><ul class="case-id-list">${memory.followUps.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
  </details>`;
}

function renderHarnessCard(harness) {
  const admin = state.user?.role === 'admin';
  const auditNote = renderArtifactAuditNote('HARNESS', harness.id);
  const test = harness.lastTest ? `<span class="badge ${harness.lastTest.passed ? 'pass' : 'fail'}">최근 시험 ${harness.lastTest.passed ? 'PASS' : 'FAIL'}</span>` : '<span class="badge">미시험</span>';
  const commands = harness.commands.map((command) => `<li><span class="mono">${escapeHtml(command.file)} ${escapeHtml((command.args || []).join(' '))}</span><small>cwd=${escapeHtml(command.cwd || '.')} · exit=${command.expectedExit} · ${command.timeoutMs}ms</small></li>`).join('');
  const commandSummary = harness.commands.slice(0, 2).map((command) => `${command.file} ${(command.args || []).join(' ')}`.trim()).join(' · ');
  const fixtures = (harness.fixtureCandidates || []).length;
  const actions = admin ? [
    `<button class="ghost" data-harness-action="test" data-harness-id="${escapeHtml(harness.id)}">시험</button>`,
    harness.status !== 'ACTIVE' ? `<button class="primary" data-harness-action="activate" data-harness-id="${escapeHtml(harness.id)}" ${harness.lastTest?.passed ? '' : 'disabled'}>활성화</button>` : '',
    harness.status === 'ACTIVE' ? `<button class="warning" data-harness-action="disable" data-harness-id="${escapeHtml(harness.id)}">비활성화</button>` : '',
  ].join('') : '';
  return `<article class="harness-card">
    <div class="harness-card-head"><div><p class="eyebrow">${escapeHtml(harness.source)} · v${harness.version}</p><h3>${escapeHtml(harness.label)}</h3><p class="mono muted">${escapeHtml(harness.id)}</p></div><span class="badge ${harness.status === 'ACTIVE' ? 'pass' : ['DISABLED', 'ARCHIVED'].includes(harness.status) ? 'fail' : ''}">${escapeHtml(harness.status)}</span></div>
    <p>${escapeHtml(harness.description || commandSummary || '설명 없음')}</p>
    <div class="task-meta">${test}<span class="badge">fixture 후보 ${fixtures}</span><span class="badge mono">${escapeHtml(harness.definitionSha256.slice(0, 12))}</span></div>
    ${auditNote}
    <div class="task-actions">${actions}</div>
    <details class="details"><summary>명령 ${formatNumber(harness.commands.length)}개</summary><ul class="command-list">${commands}</ul></details>
    ${(harness.fixtureCandidates || []).length ? `<details class="details"><summary>Fixture 후보</summary><pre>${escapeHtml(JSON.stringify(harness.fixtureCandidates, null, 2))}</pre></details>` : ''}
  </article>`;
}

function renderSkillCard(skill) {
  const admin = state.user?.role === 'admin';
  const auditNote = renderArtifactAuditNote('SKILL', skill.id);
  const actions = admin ? [
    skill.status !== 'ACTIVE' ? `<button class="primary" data-skill-action="activate" data-skill-id="${escapeHtml(skill.id)}">활성화</button>` : '',
    skill.status === 'ACTIVE' ? `<button class="warning" data-skill-action="disable" data-skill-id="${escapeHtml(skill.id)}">비활성화</button>` : '',
  ].join('') : '';
  return `<article class="harness-card">
    <div class="harness-card-head"><div><p class="eyebrow">${escapeHtml(skill.source)} · v${skill.version}</p><h3>${escapeHtml(skill.label)}</h3><p class="mono muted">${escapeHtml(skill.id)}</p></div><span class="badge ${skill.status === 'ACTIVE' ? 'pass' : ['DISABLED', 'ARCHIVED'].includes(skill.status) ? 'fail' : ''}">${escapeHtml(skill.status)}</span></div>
    <p>${escapeHtml(skill.description || '설명 없음')}</p>
    ${(skill.rules || []).slice(0, 2).map((rule) => `<p class="compact-rule">${escapeHtml(rule)}</p>`).join('')}
    <div class="task-meta"><span class="badge">사례 ${skill.sourceFailureCaseIds?.length || 0}건</span><span class="badge mono">${escapeHtml(skill.definitionSha256.slice(0, 12))}</span></div>
    ${auditNote}
    <div class="task-actions">${actions}</div>
    ${(skill.rules || []).length > 2 ? `<details class="details"><summary>규칙 ${formatNumber(skill.rules.length)}개 전체</summary><ol class="command-list">${(skill.rules || []).map((rule) => `<li>${escapeHtml(rule)}</li>`).join('')}</ol></details>` : ''}
  </article>`;
}

function renderArtifactAuditNote(type, id) {
  const finding = learningAuditFinding(type, id);
  if (!finding) return '';
  const badgeClass = finding.category === 'KEEP' ? 'pass' : finding.category === 'CLEANUP' ? 'fail' : '';
  const reason = finding.reasons?.[0] || '';
  return `<div class="task-meta"><span class="badge ${badgeClass}">${escapeHtml(finding.category)}</span><span class="badge">${escapeHtml(finding.action)}</span></div>${finding.category !== 'KEEP' ? `<p class="compact-rule">${escapeHtml(reason)}</p>` : ''}`;
}

function learningAuditFinding(type, id) {
  const list = type === 'HARNESS' ? state.learningAudit?.harnesses : state.learningAudit?.skills;
  return (list || []).find((item) => item.id === id) || null;
}

function artifactSort(a, b) {
  const rank = { ACTIVE: 0, DRAFT: 1, DISABLED: 2, ARCHIVED: 3 };
  return (rank[a.status] ?? 9) - (rank[b.status] ?? 9)
    || String(a.label || a.id).localeCompare(String(b.label || b.id));
}

function populateLearningApplyForm() {
  const form = document.querySelector('#learning-apply-form');
  if (!form) return;
  const taskValue = form.elements.taskId.value;
  const harnessValue = form.elements.harnessId.value;
  const selectedSkills = new Set([...form.elements.skillIds.selectedOptions].map((item) => item.value));
  const applicableTasks = state.tasks.filter((task) => !['DONE', 'REVIEW'].includes(task.status));
  form.elements.taskId.innerHTML = applicableTasks.map((task) => `<option value="${escapeHtml(task.id)}">${escapeHtml(task.title)} · ${escapeHtml(task.status)}</option>`).join('');
  form.elements.harnessId.innerHTML = '<option value="">변경 없음</option>' + state.harnesses.filter((item) => item.status === 'ACTIVE').map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`).join('');
  form.elements.skillIds.innerHTML = state.skills.filter((item) => item.status === 'ACTIVE').map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`).join('');
  if ([...form.elements.taskId.options].some((item) => item.value === taskValue)) form.elements.taskId.value = taskValue;
  if ([...form.elements.harnessId.options].some((item) => item.value === harnessValue)) form.elements.harnessId.value = harnessValue;
  for (const option of form.elements.skillIds.options) option.selected = selectedSkills.has(option.value);
}

function groupFailureCases(failures) {
  const groups = new Map();
  for (const failure of failures) {
    const key = failureGroupKey(failure);
    const group = groups.get(key) ?? {
      key,
      status: failure.status,
      kind: failure.kind,
      harnessIds: new Set(),
      cases: [],
      occurrences: 0,
      lastSeenAt: '',
      representative: failure,
    };
    if (failure.harnessId) group.harnessIds.add(failure.harnessId);
    group.cases.push(failure);
    group.occurrences += Number(failure.occurrences) || 0;
    if (!group.lastSeenAt || String(failure.lastSeenAt).localeCompare(group.lastSeenAt) > 0) {
      group.lastSeenAt = failure.lastSeenAt;
      group.representative = failure;
    }
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    harnessIds: [...group.harnessIds].sort(),
    harnessId: [...group.harnessIds].sort().join(', '),
  })).sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
}

function failureGroupKey(failure) {
  const identity = failure.identity || {};
  const evidence = failure.lastEvidence || {};
  if (failure.kind === 'SCOPE_VIOLATION') {
    const paths = (identity.paths || evidence.paths || evidence.changedPaths || [identity.path || evidence.path || failure.title])
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .sort();
    return [failure.status, failure.kind, failure.harnessId || '', JSON.stringify(paths)].join('|');
  }
  return [
    failure.status,
    failure.kind,
    failure.title || '',
    identity.file || evidence.file || '',
    JSON.stringify(identity.args || evidence.args || []),
    identity.cwd || evidence.cwd || '',
    identity.expectedExit ?? evidence.expectedExit ?? '',
    identity.path || evidence.path || '',
    identity.error || evidence.error || '',
  ].join('|');
}

function renderFailureGroupRow(group) {
  const failure = group.representative;
  const admin = state.user?.role === 'admin';
  const canPromote = admin && failure.status !== 'FIXTURE_CANDIDATE';
  const groupIds = group.cases.map((item) => item.id).join(',');
  const actions = [
    admin ? `<button class="primary compact" data-failure-auto-ids="${escapeHtml(groupIds)}">AI 제작</button>` : '',
    canPromote ? `<button class="ghost compact" data-failure-action="promote" data-failure-id="${escapeHtml(failure.id)}">fixture 후보</button>` : '',
    failure.status !== 'RESOLVED' ? `<button class="ghost compact" data-failure-action="resolve" data-failure-id="${escapeHtml(failure.id)}">해결</button>` : `<button class="ghost compact" data-failure-action="reopen" data-failure-id="${escapeHtml(failure.id)}">재열기</button>`,
    failure.status !== 'IGNORED' ? `<button class="ghost compact" data-failure-action="ignore" data-failure-id="${escapeHtml(failure.id)}">무시</button>` : '',
  ].join('');
  const caseDetails = group.cases.length > 1
    ? `<details class="details"><summary>포함 사례 ${group.cases.length}건</summary><ul class="case-id-list">${group.cases.map((item) => `<li><span class="mono">${escapeHtml(item.id)}</span> · ${escapeHtml(item.title)} · ${formatNumber(item.occurrences)}회</li>`).join('')}</ul></details>`
    : `<small class="mono">${escapeHtml(failure.id)}</small>`;
  return `<tr>
    <td><span class="badge ${failure.status === 'OPEN' ? 'fail' : failure.status === 'RESOLVED' ? 'pass' : ''}">${escapeHtml(failure.status)}</span></td>
    <td>${escapeHtml(group.kind)}</td><td class="mono">${escapeHtml(group.harnessId || '-')}</td><td>${formatNumber(group.cases.length)}</td><td>${formatNumber(group.occurrences)}</td><td>${escapeHtml(formatDateTime(group.lastSeenAt))}</td>
    <td><strong>${escapeHtml(failure.title)}</strong>${caseDetails}<details class="details"><summary>대표 증거</summary><pre>${escapeHtml(JSON.stringify(failure.lastEvidence, null, 2))}</pre></details></td>
    <td><div class="inline-actions">${actions}</div></td>
  </tr>`;
}

function render() {
  renderSummary();
  renderMilestonePlanner();
  renderAgentActivityPanel();
  const filteredTasks = filterTasksByPeople(state.tasks, state.boardFilter);
  board.innerHTML = columns.map(([status, label]) => {
    const tasks = filteredTasks.filter((task) => task.status === status && !task.archived);
    return `
      <section class="column" data-status="${status}">
        <div class="column-header"><h2>${label}</h2><span class="count">${tasks.length}</span></div>
        <div class="card-list">${tasks.length ? tasks.map(renderTask).join('') : '<div class="empty">작업 없음</div>'}</div>
      </section>`;
  }).join('') + renderArchivedSection(filteredTasks);
}

function renderMilestonePlanner() {
  if (!milestoneCalendar || !milestoneStream || milestonePanel.classList.contains('hidden')) return;
  const month = state.milestoneMonth || new Date().toISOString().slice(0, 7);
  document.querySelector('#milestone-month').textContent = month;
  populateScheduleTaskOptions();
  populateMilestoneFilters();
  const monthEvents = timelineEvents().filter((event) => event.date.startsWith(month));
  const events = filterMilestoneEvents(monthEvents);
  if (milestoneRanges) milestoneRanges.innerHTML = renderMilestoneRanges(month);
  const days = daysInMonth(month);
  const first = new Date(`${month}-01T00:00:00`).getDay();
  const cells = [];
  for (let index = 0; index < first; index += 1) cells.push('<div class="milestone-day muted-day"></div>');
  for (const day of days) {
    const allDayEvents = monthEvents.filter((event) => event.date === day);
    const visibleDayEvents = events.filter((event) => event.date === day);
    cells.push(`<div class="milestone-day ${state.milestoneFilter.date === day ? 'selected-day' : ''}" data-milestone-date="${escapeHtml(day)}">
      <div class="milestone-date"><span>${escapeHtml(day.slice(8))}</span>${allDayEvents.length ? `<strong>${allDayEvents.length}</strong>` : ''}</div>
      ${renderMilestoneDaySummary(visibleDayEvents)}
    </div>`);
  }
  milestoneCalendar.innerHTML = `<div class="milestone-weekdays">${['일', '월', '화', '수', '목', '금', '토'].map((day) => `<span>${day}</span>`).join('')}</div><div class="milestone-grid">${cells.join('')}</div>`;
  milestoneStream.innerHTML = events.length
    ? `<div class="milestone-stream-head"><strong>${formatNumber(events.length)}개 이벤트</strong><span class="muted">${state.milestoneFilter.date || month}</span></div>${events.sort((a, b) => a.at.localeCompare(b.at)).map(renderMilestoneRow).join('')}`
    : '<div class="empty">이 달에 표시할 작업 이벤트가 없습니다.</div>';
}

function renderMilestoneRanges(month) {
  if (state.milestoneFilter.type && state.milestoneFilter.type !== 'planned') {
    return '<div class="milestone-range-empty">기간표는 계획 보기에서 표시됩니다. 필터를 전체 또는 계획으로 바꾸면 시작-마감 범위를 볼 수 있습니다.</div>';
  }
  const monthDays = daysInMonth(month);
  const tasks = filterMilestoneTasks(state.tasks)
    .filter((task) => task.schedule?.plannedStart || task.schedule?.plannedEnd)
    .map((task) => milestoneRangeForTask(task, month))
    .filter(Boolean)
    .sort((a, b) => a.start.localeCompare(b.start) || a.task.title.localeCompare(b.task.title));
  if (!tasks.length) return '<div class="milestone-range-empty">이 달에 계획 시작/마감이 잡힌 작업이 없습니다.</div>';
  return `<section class="milestone-range-board" style="--month-days:${monthDays.length}" aria-label="작업 기간표">
    <div class="milestone-range-head">
      <strong>작업 기간표</strong>
      <span class="muted">${escapeHtml(month)} · ${formatNumber(tasks.length)}개 작업</span>
    </div>
    <div class="milestone-range-scale" style="grid-template-columns:repeat(${monthDays.length}, minmax(26px, 1fr))">${monthDays.map((day) => `<span>${escapeHtml(day.slice(8))}</span>`).join('')}</div>
    <div class="milestone-range-list">${tasks.map(renderMilestoneRangeRow).join('')}</div>
  </section>`;
}

function filterMilestoneTasks(tasks) {
  const { userId, query, date } = state.milestoneFilter;
  const normalizedQuery = String(query || '').trim().toLowerCase();
  return tasks.filter((task) => {
    if (task.archived) return false;
    if (userId && task.assigneeUserId !== userId) return false;
    if (normalizedQuery && !String(task.title || '').toLowerCase().includes(normalizedQuery)) return false;
    if (date) {
      const start = task.schedule?.plannedStart || task.schedule?.plannedEnd || '';
      const end = task.schedule?.plannedEnd || task.schedule?.plannedStart || '';
      if (!start || !end || date < start || date > end) return false;
    }
    return true;
  });
}

function milestoneRangeForTask(task, month) {
  const monthDays = daysInMonth(month);
  const monthStart = monthDays[0];
  const monthEnd = monthDays[monthDays.length - 1];
  const rawStart = task.schedule?.plannedStart || task.schedule?.plannedEnd || '';
  const rawEnd = task.schedule?.plannedEnd || task.schedule?.plannedStart || '';
  if (!rawStart || !rawEnd) return null;
  if (rawEnd < monthStart || rawStart > monthEnd) return null;
  const start = rawStart < monthStart ? monthStart : rawStart;
  const end = rawEnd > monthEnd ? monthEnd : rawEnd;
  const startDay = Number(start.slice(8));
  const endDay = Number(end.slice(8));
  const total = monthDays.length;
  return {
    task,
    start,
    end,
    startsBeforeMonth: rawStart < monthStart,
    endsAfterMonth: rawEnd > monthEnd,
    left: ((startDay - 1) / total) * 100,
    width: ((endDay - startDay + 1) / total) * 100,
  };
}

function renderMilestoneRangeRow(range) {
  const task = range.task;
  const statusClass = `status-${String(task.status || '').toLowerCase().replace(/_/g, '-')}`;
  const startLabel = task.schedule?.plannedStart || '시작 미정';
  const endLabel = task.schedule?.plannedEnd || '마감 미정';
  const edges = `${range.startsBeforeMonth ? '이전부터 · ' : ''}${range.endsAfterMonth ? '다음달까지' : ''}`.trim();
  return `<button class="milestone-range-row" type="button" data-schedule-task="${escapeHtml(task.id)}">
    <span class="milestone-range-title">
      <strong>${escapeHtml(task.title)}</strong>
      <small>${escapeHtml([userName(task.assigneeUserId) || '미지정', statusLabel(task.status), edges].filter(Boolean).join(' · '))}</small>
    </span>
    <span class="milestone-range-track">
      <span class="milestone-range-bar ${escapeHtml(statusClass)}" style="left:${range.left.toFixed(3)}%;width:${Math.max(range.width, 3).toFixed(3)}%">
        <span>${escapeHtml(startLabel)} → ${escapeHtml(endLabel)}</span>
      </span>
    </span>
  </button>`;
}

function timelineEvents() {
  const taskMap = new Map(state.tasks.map((task) => [task.id, task]));
  return (state.taskTimeline || []).flatMap((item) => (item.events || []).map((event) => {
    const task = taskMap.get(item.taskId) || item;
    const at = String(event.at || '');
    return {
      ...event,
      at,
      date: at.slice(0, 10),
      taskId: item.taskId,
      title: item.title,
      status: item.status,
      assigneeUserId: task.assigneeUserId,
      category: milestoneCategory(event.type),
      scheduleNote: item.schedule?.note || '',
    };
  })).filter((event) => /^\d{4}-\d{2}-\d{2}/.test(event.date));
}

function renderMilestoneDaySummary(events) {
  if (!events.length) return '<div class="milestone-empty-day"></div>';
  const counts = new Map();
  for (const event of events) counts.set(event.category, (counts.get(event.category) || 0) + 1);
  return `<div class="milestone-counts">${[...counts.entries()].map(([category, count]) => `<span class="milestone-count type-${escapeHtml(category)}">${escapeHtml(categoryLabel(category))} ${formatNumber(count)}</span>`).join('')}</div>`;
}

function renderMilestoneRow(event) {
  const actor = event.actorUserId ? userName(event.actorUserId) : '';
  const note = event.scheduleNote && event.type.startsWith('planned') ? `<small>${escapeHtml(event.scheduleNote)}</small>` : '';
  return `<button class="milestone-row" type="button" data-schedule-task="${escapeHtml(event.taskId)}">
    <span class="milestone-row-date">${escapeHtml(event.date)}</span>
    <span class="badge">${escapeHtml(event.label)}</span>
    <strong>${escapeHtml(event.title)}</strong>
    <span class="muted">${escapeHtml([userName(event.assigneeUserId), actor].filter(Boolean).join(' · '))}</span>
    ${note}
  </button>`;
}

function filterMilestoneEvents(events) {
  const { type, userId, query, date } = state.milestoneFilter;
  const normalizedQuery = String(query || '').trim().toLowerCase();
  return events.filter((event) => {
    if (type && event.category !== type) return false;
    if (userId && event.assigneeUserId !== userId && event.actorUserId !== userId) return false;
    if (date && event.date !== date) return false;
    if (normalizedQuery && !event.title.toLowerCase().includes(normalizedQuery)) return false;
    return true;
  });
}

function populateMilestoneFilters() {
  document.querySelector('#milestone-event-filter').value = state.milestoneFilter.type;
  document.querySelector('#milestone-search').value = state.milestoneFilter.query;
  const userFilter = document.querySelector('#milestone-user-filter');
  const current = state.milestoneFilter.userId;
  userFilter.innerHTML = '<option value="">전체 담당자</option>' + state.users.map((user) => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.name)}</option>`).join('');
  if (state.users.some((user) => user.id === current)) userFilter.value = current;
  else state.milestoneFilter.userId = '';
}

function milestoneCategory(type) {
  if (String(type).startsWith('planned')) return 'planned';
  if (String(type).startsWith('verify')) return 'verify';
  if (['review'].includes(type)) return 'review';
  if (['done', 'archived'].includes(type)) return 'done';
  if (['blocked', 'rejected'].includes(type)) return 'blocked';
  return type === 'claimed' ? 'claimed' : 'other';
}

function categoryLabel(category) {
  return ({ planned: '계획', claimed: '가져감', verify: '검증', review: '리뷰', done: '완료', blocked: '막힘', other: '기타' })[category] || category;
}

function statusLabel(status) {
  return ({
    READY: '준비',
    IN_PROGRESS: '진행 중',
    REVIEW: '리뷰',
    BLOCKED: '막힘',
    DONE: '완료',
  })[status] || status || '';
}

function daysInMonth(month) {
  const [year, rawMonth] = month.split('-').map(Number);
  const last = new Date(year, rawMonth, 0).getDate();
  return Array.from({ length: last }, (_item, index) => `${month}-${String(index + 1).padStart(2, '0')}`);
}

function shiftMilestoneMonth(delta) {
  const [year, month] = state.milestoneMonth.split('-').map(Number);
  const next = new Date(year, month - 1 + delta, 1);
  state.milestoneMonth = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
  renderMilestonePlanner();
}

function populateScheduleTaskOptions() {
  const form = document.querySelector('#schedule-form');
  if (!form) return;
  if (form.contains(document.activeElement) && form.elements.taskId.options.length) return;
  const current = form.elements.taskId.value;
  const tasks = [...state.tasks].sort((a, b) => Number(a.archived) - Number(b.archived) || String(a.title).localeCompare(String(b.title)));
  form.elements.taskId.innerHTML = tasks.map((task) => `<option value="${escapeHtml(task.id)}">${escapeHtml(task.title)} · ${escapeHtml(task.status)}</option>`).join('');
  const selected = tasks.some((task) => task.id === current) ? current : tasks[0]?.id;
  if (selected) form.elements.taskId.value = selected;
  populateScheduleForm(selected);
}

function populateScheduleForm(taskId) {
  const form = document.querySelector('#schedule-form');
  const task = state.tasks.find((item) => item.id === taskId);
  if (!form || !task) return;
  form.elements.plannedStart.value = task.schedule?.plannedStart || '';
  form.elements.plannedEnd.value = task.schedule?.plannedEnd || '';
  form.elements.note.value = task.schedule?.note || '';
}

function renderArchivedSection(tasks = state.tasks) {
  const archived = tasks.filter((task) => task.archived);
  if (!archived.length) return '';
  return `<details class="details" style="grid-column:1/-1"><summary>아카이브 (${archived.length})</summary><div class="card-list">${archived.map(renderTask).join('')}</div></details>`;
}

function renderSummary() {
  document.querySelector('#summary').innerHTML = columns.map(([status, label]) =>
    `<span>${label} ${state.tasks.filter((task) => task.status === status && !task.archived).length}</span>`
  ).join('');
}

function renderAgentActivityPanel() {
  if (!agentActivityPanel) return;
  const active = state.tasks
    .filter((task) => !task.archived && task.agentActivity && !task.agentActivity.finishedAt)
    .sort((a, b) => String(b.agentActivity.updatedAt || '').localeCompare(String(a.agentActivity.updatedAt || '')));
  const recent = active.length ? active : state.tasks
    .filter((task) => !task.archived && task.agentActivity)
    .sort((a, b) => String(b.agentActivity.updatedAt || '').localeCompare(String(a.agentActivity.updatedAt || '')))
    .slice(0, 3);
  if (!recent.length) {
    agentActivityPanel.innerHTML = '<div class="agent-activity-empty">아직 보드에 표시할 AI/CLI 작업 현황이 없습니다.</div>';
    return;
  }
  agentActivityPanel.innerHTML = `
    <div class="agent-activity-head">
      <strong>AI/CLI 작업 현황</strong>
      <span class="muted">${active.length ? `${formatNumber(active.length)}개 실행 중` : '최근 작업'}</span>
    </div>
    <div class="agent-activity-list">${recent.map(renderAgentActivityItem).join('')}</div>`;
}

function renderAgentActivityItem(task) {
  const activity = task.agentActivity || {};
  const attempt = activity.attempt && activity.maxAttempts ? `${activity.attempt}/${activity.maxAttempts}` : '';
  const stateClass = activity.finishedAt ? (activity.passed ? 'done' : 'failed') : 'active';
  return `<button class="agent-activity-item ${stateClass}" type="button" data-agent-task="${escapeHtml(task.id)}">
    <span class="agent-activity-pulse"></span>
    <span>
      <strong>${escapeHtml(task.title)}</strong>
      <small>${escapeHtml(['에이전트 실행', attempt ? `시도 ${attempt}` : '', userName(task.assigneeUserId)].filter(Boolean).join(' · '))}</small>
    </span>
    <span class="muted">${escapeHtml(relativeTime(activity.updatedAt))}</span>
  </button>`;
}

function renderTask(task) {
  const assignee = userName(task.assigneeUserId) || '미지정';
  const reviewer = userName(task.reviewerUserId) || '누구나';
  const verification = task.verification;
  const verificationBadge = verification
    ? `<span class="badge ${verification.passed ? 'pass' : verification.status === 'RUNNING' ? '' : 'fail'}">검증 ${escapeHtml(verification.status)}</span>`
    : '<span class="badge">미검증</span>';
  const scope = (task.allowedPaths || []).map((item) => `<span class="badge mono">${escapeHtml(item)}</span>`).join('');
  const details = verification ? `<details class="details"><summary>검증 원문</summary><pre>${escapeHtml(JSON.stringify(verification, null, 2))}</pre></details>` : '';
  const result = renderTaskResult(task);
  const blocked = task.blocked ? `<p class="error">막힘: ${escapeHtml(task.blocked.reason)}</p>` : '';
  const review = task.review?.comment ? `<p class="muted">리뷰: ${escapeHtml(task.review.comment)}</p>` : '';
  const criteria = renderListSection('완료 조건', task.acceptanceCriteria);
  const aiDetails = renderTaskAI(task.ai);
  const executionLabel = publicExecutionLabel(task);
  const executionBadge = executionLabel ? `<span class="badge ${task.executionState === 'RUNNING' ? 'pass' : ''}">${escapeHtml(executionLabel)}</span>` : '';
  const agentActivity = renderTaskAgentActivity(task);

  return `
    <article class="task-card" data-task-card="${escapeHtml(task.id)}">
      <p class="eyebrow">P${task.priority} · v${task.version}</p>
      <h3>${escapeHtml(task.title)}</h3>
      <p class="task-description">${escapeHtml(task.description || '설명 없음')}</p>
      ${criteria}
      <div class="task-meta">
        <span class="badge">담당 ${escapeHtml(assignee)}</span>
        <span class="badge">리뷰 ${escapeHtml(reviewer)}</span>
        <span class="badge">${escapeHtml(task.verificationProfile)}</span>
        ${(task.skillIds || []).map((id) => `<span class="badge">skill:${escapeHtml(id)}</span>`).join('')}
        ${verificationBadge}
        ${executionBadge}
        ${task.supersedesTaskId ? `<span class="badge">대체 작업 · ${escapeHtml(task.supersedesTaskId)}</span>` : ''}
        ${task.supersededByTaskId ? `<span class="badge">대체됨 · ${escapeHtml(task.supersededByTaskId)}</span>` : ''}
      </div>
      <div class="task-meta">${scope}</div>
      ${agentActivity}
      ${result}
      ${blocked}${review}
      <div class="task-actions">${renderActions(task)}</div>
      ${aiDetails}${details}
    </article>`;
}

function renderTaskResult(task) {
  const verification = task.verification;
  if (!verification) return '';
  const executor = verification.executor || task.executor;
  const changedPaths = verification.changedPaths || [];
  const checks = verification.checks || [];
  return `<section class="task-result ${verification.passed ? 'passed' : 'failed'}">
    <div class="task-result-heading">
      <div><p class="eyebrow">작업 결과</p><strong>${escapeHtml(taskResultSummary(task))}</strong></div>
      ${executor ? `<span class="badge">${escapeHtml([executor.tool, executor.model].filter(Boolean).join(' / '))}</span>` : ''}
    </div>
    <div class="task-result-grid">
      <div><small>변경 파일</small>${changedPaths.length ? `<ul>${changedPaths.map((path) => `<li><code>${escapeHtml(path)}</code></li>`).join('')}</ul>` : '<p class="muted">기록 없음</p>'}</div>
      <div><small>검증</small>${checks.length ? `<ul>${checks.map((check) => `<li class="${check.passed ? 'pass-text' : 'fail-text'}">${check.passed ? '통과' : '실패'} · <code>${escapeHtml([check.file, ...(check.args || [])].filter(Boolean).join(' '))}</code></li>`).join('')}</ul>` : '<p class="muted">실행 기록 없음</p>'}</div>
    </div>
  </section>`;
}

function renderTaskAgentActivity(task) {
  const activity = task.agentActivity;
  if (!activity) return '';
  const attempt = activity.attempt && activity.maxAttempts ? ` · 시도 ${activity.attempt}/${activity.maxAttempts}` : '';
  const stateClass = activity.finishedAt ? (activity.passed ? 'done' : 'failed') : 'active';
  return `<section class="task-agent-activity ${stateClass}">
    <div><strong>에이전트 실행 중</strong><span>${escapeHtml(relativeTime(activity.updatedAt))}${escapeHtml(attempt)}</span></div>
  </section>`;
}

function renderTaskAI(ai) {
  if (!ai?.brief && !ai?.verificationSummary) return '';
  const brief = ai.brief ? `
    <section class="ai-advice">
      <p class="eyebrow">AI 작업 브리프 · 참고용</p>
      <p>${escapeHtml(ai.brief.summary)}</p>
      ${renderListSection('구현 단계', ai.brief.implementationSteps)}
      ${renderListSection('리뷰 체크', ai.brief.reviewChecklist)}
      ${renderListSection('위험', ai.brief.risks)}
      ${renderListSection('열린 질문', ai.brief.openQuestions)}
    </section>` : '';
  const summary = ai.verificationSummary ? `
    <section class="ai-advice">
      <p class="eyebrow">AI 검증 요약 · ${escapeHtml(ai.verificationSummary.verdict)}</p>
      <p>${escapeHtml(ai.verificationSummary.summary)}</p>
      ${renderListSection('실패 검사', ai.verificationSummary.failedChecks)}
      ${renderListSection('범위 문제', ai.verificationSummary.scopeIssues)}
      ${renderListSection('리뷰 초점', ai.verificationSummary.reviewerFocus)}
      ${renderListSection('다음 행동', ai.verificationSummary.nextActions)}
    </section>` : '';
  return `<details class="details ai-details" open><summary>AI 제안</summary>${brief}${summary}</details>`;
}

function renderListSection(title, items = []) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return `<div class="list-section"><strong>${escapeHtml(title)}</strong><ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>`;
}

function renderActions(task) {
  const mine = task.assigneeUserId === state.user.id;
  const admin = state.user.role === 'admin';
  const participant = [task.creatorUserId, task.assigneeUserId, task.reviewerUserId].includes(state.user.id) || admin;
  const actions = [];
  actions.push(task.verification
    ? actionButton(task, 'download-result', '결과 다운로드')
    : actionButton(task, 'download-spec', '명세서 다운로드'));
  if (task.status === 'READY' && (!task.assigneeUserId || mine) && task.executionState !== 'QUEUED') actions.push(actionButton(task, 'claim', '직접 시작'));
  if (task.status === 'READY' && (mine || admin) && task.assigneeUserId && task.executionState !== 'QUEUED') actions.push(actionButton(task, 'queue-agent', '에이전트 대기'));
  if (task.status === 'READY' && (mine || admin) && task.executionState === 'QUEUED') actions.push(actionButton(task, 'cancel-agent', '대기 취소'));
  if (task.status === 'IN_PROGRESS' && (mine || admin)) {
    actions.push(actionButton(task, 'verify', task.verification?.status === 'RUNNING' ? '검증 중…' : '검증 실행', 'primary'));
    if (task.verification?.passed) actions.push(actionButton(task, 'request-review', '리뷰 요청'));
  }
  if (canReviewTask(task, state.user)) {
    actions.push(actionButton(task, 'approve', '승인', 'primary'));
    actions.push(actionButton(task, 'reject', '반려', 'danger'));
  }
  if (task.status !== 'DONE' && task.status !== 'BLOCKED' && participant) actions.push(actionButton(task, 'block', '막힘', 'warning'));
  if (task.status === 'BLOCKED' && participant) actions.push(actionButton(task, 'unblock', '다시 준비'));
  if (state.ai.enabled && participant && task.status !== 'DONE') actions.push(actionButton(task, 'ai-brief', 'AI 브리프'));
  if (state.ai.enabled && participant && task.verification) actions.push(actionButton(task, 'ai-verification-summary', 'AI 검증 요약'));
  if (!task.archived && task.status !== 'DONE' && participant) actions.push(actionButton(task, 'dispatch-command', 'CLI 명령'));
  if (task.status === 'DONE' && participant && !task.archived) actions.push(actionButton(task, 'archive', '아카이브'));
  if (task.archived && participant) actions.push(actionButton(task, 'unarchive', '복원', 'primary'));
  if (task.creatorUserId === state.user.id || admin) actions.push(actionButton(task, 'delete', '삭제', 'danger'));
  return actions.join('');
}

async function copyDispatchCommand(task) {
  const executor = task.executor?.tool || 'codex';
  const model = task.executor?.model ? ` --model ${shellArg(task.executor.model)}` : '';
  const command = `team-loop --server ${shellArg(window.location.origin)} dispatch ${shellArg(task.id)} --executor ${shellArg(executor)}${model} --execute --retry 3 --auto-learn --to review`;
  try {
    await navigator.clipboard.writeText(command);
    showToast('CLI 실행 명령을 복사했습니다.');
  } catch {
    window.prompt('터미널에서 실행할 명령', command);
  }
}

function shellArg(value) {
  const text = String(value || '');
  return /^[A-Za-z0-9_./:-]+$/.test(text) ? text : `"${text.replaceAll('"', '\\"')}"`;
}

function actionButton(task, action, label, className = 'ghost') {
  return `<button class="${className}" type="button" data-action="${action}" data-task-id="${escapeHtml(task.id)}">${escapeHtml(label)}</button>`;
}

function userName(userId) {
  return state.users.find((user) => user.id === userId)?.name || '';
}

async function api(url, { method = 'GET', body } = {}) {
  const headers = { 'X-Team-Loop-Client': 'web' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.details = payload.details;
    throw error;
  }
  return payload;
}

function lines(value) {
  return String(value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function startPolling() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(() => refreshCurrentView(true), 5000);
}

function stopPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

let toastTimer;
function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.style.borderColor = isError ? 'var(--danger)' : '';
  toast.classList.remove('hidden');
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3600);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function downloadTaskSpec(task) {
  const markdown = buildTaskSpecMarkdown(task, state.users, new Date(), {
    profiles: state.profiles,
    skills: state.skills,
  });
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = taskSpecFilename(task);
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast('작업 명세서를 다운로드했습니다.');
}

function downloadTaskResult(task) {
  const markdown = buildTaskResultMarkdown(task, state.users);
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = taskResultFilename(task);
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast('작업 결과를 다운로드했습니다.');
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(String(value ?? ''));
  return String(value ?? '').replace(/["\\]/g, '\\$&');
}

const renderFailureCaseArchive = renderCaseArchive;
renderCaseArchive = function renderCaseArchiveWithLearningArtifacts() {
  renderFailureCaseArchive();
  if (!caseArchive) return;
  const artifacts = archivedLearningArtifacts();
  if (!artifacts.length) return;
  const count = document.querySelector('#case-archive-count');
  if (count) {
    const base = Number(String(count.textContent || '').match(/\d+/)?.[0] || 0);
    count.textContent = `${formatNumber(base + artifacts.length)} entries`;
  }
  caseArchive.innerHTML = `${artifacts.map(renderArchivedArtifactCard).join('')}${caseArchive.innerHTML}`;
};

function archivedLearningArtifacts() {
  return [
    ...state.harnesses.filter((item) => item.status === 'ARCHIVED').map((item) => ({ ...item, artifactType: 'HARNESS' })),
    ...state.skills.filter((item) => item.status === 'ARCHIVED').map((item) => ({ ...item, artifactType: 'SKILL' })),
  ].sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id)));
}

function renderArchivedArtifactCard(item) {
  const details = item.artifactType === 'HARNESS'
    ? `<details class="details"><summary>Commands</summary><pre>${escapeHtml(JSON.stringify(item.commands || [], null, 2))}</pre></details>`
    : `<details class="details"><summary>Rules</summary><ol class="command-list">${(item.rules || []).map((rule) => `<li>${escapeHtml(rule)}</li>`).join('')}</ol></details>`;
  return `<details class="case-archive-item">
    <summary class="case-archive-summary">
      <span class="badge">ARCHIVED</span>
      <strong>${escapeHtml(item.label || item.id)}</strong>
      <span class="muted">${escapeHtml(item.artifactType)}</span>
      <span class="badge">${escapeHtml(item.source || '-')}</span>
      <span class="badge">v${escapeHtml(item.version || 1)}</span>
      <span class="badge mono">${escapeHtml(item.id)}</span>
    </summary>
    <div class="case-archive-body">
      <p>${escapeHtml(item.description || 'No description')}</p>
      ${details}
    </div>
  </details>`;
}

bootstrap();
