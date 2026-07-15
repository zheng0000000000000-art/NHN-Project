const state = {
  user: null,
  users: [],
  tasks: [],
  profiles: {},
  ai: { enabled: false, missing: [] },
  workspace: null,
  pollTimer: null,
  aiResults: null,
  usage: null,
  usageDays: 30,
  activeView: 'usage',
  harnesses: [],
  skills: [],
  failures: [],
  failureSummary: { total: 0, open: 0, fixtureCandidates: 0, resolved: 0, ignored: 0, occurrences: 0 },
};

const columns = [
  ['READY', '준비'],
  ['IN_PROGRESS', '진행 중'],
  ['REVIEW', '리뷰'],
  ['BLOCKED', '막힘'],
  ['DONE', '완료'],
];

const authView = document.querySelector('#auth-view');
const workspaceView = document.querySelector('#workspace-view');
const authError = document.querySelector('#auth-error');
const taskFormPanel = document.querySelector('#task-form-panel');
const taskFormError = document.querySelector('#task-form-error');
const aiPanel = document.querySelector('#ai-panel');
const aiError = document.querySelector('#ai-error');
const aiResults = document.querySelector('#ai-results');
const board = document.querySelector('#board');
const usageView = document.querySelector('#usage-view');
const boardView = document.querySelector('#board-view');
const harnessView = document.querySelector('#harness-view');
const harnessFormError = document.querySelector('#harness-form-error');
const harnessList = document.querySelector('#harness-list');
const skillList = document.querySelector('#skill-list');
const learningFormError = document.querySelector('#learning-form-error');
const learningApplyError = document.querySelector('#learning-apply-error');
const failureList = document.querySelector('#failure-list');
const toast = document.querySelector('#toast');

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

for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', async () => {
    switchView(button.dataset.view);
    if (state.activeView === 'usage') await loadUsage({ quiet: false });
    if (state.activeView === 'harnesses') renderHarnessDashboard();
  });
}

document.querySelector('#usage-refresh').addEventListener('click', () => loadUsage({ quiet: false }));
document.querySelector('#usage-days').addEventListener('change', async (event) => {
  state.usageDays = Number(event.target.value) || 30;
  await loadUsage({ quiet: false });
});

document.querySelector('#harness-refresh').addEventListener('click', async () => {
  await bootstrap({ quiet: true });
  renderHarnessDashboard();
  showToast('하네스와 실패사례를 갱신했습니다.');
});

document.querySelector('#failure-status-filter').addEventListener('change', renderHarnessDashboard);

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
  button.disabled = true;
  try {
    if (action === 'claim') await taskAction(task, 'claim');
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
    renderAIStatus();
    render();
    renderHarnessDashboard();
    switchView(state.activeView);
    if (state.activeView === 'usage') await loadUsage({ quiet: true });
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

  const profile = form.elements.verificationProfile;
  const currentProfile = profile.value;
  profile.innerHTML = Object.values(state.profiles).map((item) =>
    `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)} · ${item.commandCount} checks</option>`
  ).join('');
  if ([...profile.options].some((option) => option.value === currentProfile)) profile.value = currentProfile;
}

function resetTaskForm(form) {
  form.reset();
  form.elements.priority.value = '100';
  form.elements.allowedPaths.value = '**';
  populateTaskForm();
}

function userOption(user) {
  return `<option value="${escapeHtml(user.id)}">${escapeHtml(user.name)}</option>`;
}

function renderAIStatus() {
  const badge = document.querySelector('#ai-status');
  const disabled = document.querySelector('#ai-disabled-message');
  badge.textContent = state.ai.enabled ? `AI ${state.ai.model}` : 'AI 꺼짐';
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
  if (!quiet) showToast(state.activeView === 'usage' ? '사용량을 갱신했습니다.' : state.activeView === 'harnesses' ? '하네스를 갱신했습니다.' : '최신 상태를 불러왔습니다.');
}

function switchView(view) {
  state.activeView = ['usage', 'board', 'harnesses'].includes(view) ? view : 'usage';
  usageView.classList.toggle('hidden', state.activeView !== 'usage');
  boardView.classList.toggle('hidden', state.activeView !== 'board');
  harnessView.classList.toggle('hidden', state.activeView !== 'harnesses');
  for (const button of document.querySelectorAll('[data-view]')) {
    button.classList.toggle('active', button.dataset.view === state.activeView);
  }
}

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
    kpiCard('총 토큰', formatTokens(totals.totalTokens), `${formatNumber(totals.requests)}회 요청`, 'token'),
    kpiCard('입력 토큰', formatTokens(totals.inputTokens), `캐시 ${formatPercent(totals.cacheRate)}`, 'input'),
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
    kpiCard('CLI 총 토큰', formatTokens(totals.totalTokens), `${formatNumber(totals.windows)}개 수집 창`, 'token'),
    kpiCard('CLI 입력 토큰', formatTokens(totals.inputTokens), `캐시 ${formatPercent(totals.inputTokens ? totals.inputCachedTokens / totals.inputTokens : 0)}`, 'input'),
    kpiCard('CLI 출력 토큰', formatTokens(totals.outputTokens), `추론 ${formatTokens(totals.reasoningTokens)}`, 'output'),
    kpiCard('잔여 한도', quota ? `${externalQuotaPercent(quota)}%` : '없음', quota ? `${quota.label}` : 'usage push 필요', quota ? 'ok' : 'latency'),
    kpiCard('연결 도구', formatNumber(external.byTool.length), external.byTool.map((item) => externalToolLabel(item.tool)).join(', ') || '없음', 'latency'),
    kpiCard('API 비용', '미사용', 'OpenAI API 키 없음', 'cost'),
  ].join('');

  document.querySelector('#usage-budgets').innerHTML = [
    `<article class="budget-card unconfigured"><div><p>서버 API 모드</p><strong>꺼짐</strong></div><p class="muted">현재 화면은 로컬 CLI 사용량을 보여줍니다.</p></article>`,
    `<article class="budget-card unconfigured"><div><p>Codex 주간 한도</p><strong>${quota ? `${externalQuotaPercent(quota)}% 사용` : '없음'}</strong></div><p class="muted">${quota?.resetsAt ? `리셋 ${formatDateTime(quota.resetsAt)}` : 'team-loop usage push로 갱신하세요.'}</p></article>`,
    `<article class="budget-card unconfigured"><div><p>수집 범위</p><strong>외부 도구</strong></div><p class="muted">서버 예산에는 합산하지 않는 참고 집계입니다.</p></article>`,
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
  return external?.quota?.flatMap((entry) => entry.windows || [])[0] || null;
}

function externalQuotaPercent(quota) {
  return Number(quota.effectiveUsedPercent ?? quota.usedPercent ?? 0).toFixed(1);
}

function renderExternalPrimaryUsers(users) {
  const target = document.querySelector('#usage-users');
  if (!users.length) {
    target.innerHTML = '<div class="empty">아직 사용자별 CLI 사용량 기록이 없습니다.</div>';
    return;
  }
  target.innerHTML = `<table><thead><tr><th>사용자</th><th>윈도우</th><th>입력</th><th>출력</th><th>총 토큰</th></tr></thead><tbody>${users.map((item) => `<tr><td><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.role || '')}</small></td><td>${formatNumber(item.windows)}</td><td>${formatTokens(item.inputTokens)}</td><td>${formatTokens(item.outputTokens)}</td><td>${formatTokens(item.totalTokens)}</td></tr>`).join('')}</tbody></table>`;
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
    userTarget.innerHTML = `<table><thead><tr><th>사용자</th><th>윈도우</th><th>입력</th><th>출력</th><th>총 토큰</th></tr></thead><tbody>${external.byUser.map((item) => `<tr><td><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.role || '')}</small></td><td>${formatNumber(item.windows)}</td><td>${formatTokens(item.inputTokens)}</td><td>${formatTokens(item.outputTokens)}</td><td>${formatTokens(item.totalTokens)}</td></tr>`).join('')}</tbody></table>`;
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
    <div class="rank-copy"><strong>${escapeHtml(labeler(item[key]))}</strong><span>${formatNumber(item.windows)}개 창 · ${formatTokens(item.totalTokens)}</span></div>
    <div class="mini-progress"><i style="width:${Math.round(item.totalTokens / max * 100)}%"></i></div>
  </div>`).join('');
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
  target.innerHTML = `<table><thead><tr><th>사용자</th><th>요청</th><th>입력</th><th>출력</th><th>총 토큰</th><th>비중</th></tr></thead><tbody>${users.map((item) => {
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
    kpiCard('열린 실패', formatNumber(summary.open), `${formatNumber(summary.occurrences)}회 관찰`, summary.open ? 'danger' : 'ok'),
    kpiCard('Fixture 후보', formatNumber(summary.fixtureCandidates), '재현 setup 필요', 'output'),
    kpiCard('활성 스킬', formatNumber(activeSkills), `${formatNumber(state.skills.length)}개 등록`, 'ok'),
  ].join('');
  document.querySelector('#harness-create-panel').classList.toggle('hidden', state.user?.role !== 'admin');
  document.querySelector('#learning-create-panel').classList.toggle('hidden', state.user?.role !== 'admin');
  document.querySelector('#harness-count').textContent = `${state.harnesses.length}개`;
  document.querySelector('#skill-count').textContent = `${state.skills.length}개`;
  document.querySelector('#failure-count').textContent = `${summary.total || 0}건 · ${summary.occurrences || 0}회`;
  harnessList.innerHTML = state.harnesses.length ? state.harnesses.map(renderHarnessCard).join('') : '<div class="empty">등록된 하네스가 없습니다.</div>';
  skillList.innerHTML = state.skills.length ? state.skills.map(renderSkillCard).join('') : '<div class="empty">실패에서 제작한 스킬이 없습니다.</div>';
  populateLearningApplyForm();

  const selectedStatus = document.querySelector('#failure-status-filter').value;
  const failures = state.failures.filter((item) => !selectedStatus || item.status === selectedStatus);
  failureList.innerHTML = failures.length ? `<table><thead><tr><th>상태</th><th>종류</th><th>하네스</th><th>횟수</th><th>마지막</th><th>대상</th><th>행동</th></tr></thead><tbody>${failures.map(renderFailureRow).join('')}</tbody></table>` : '<div class="empty">조건에 맞는 실패사례가 없습니다.</div>';
}

function renderHarnessCard(harness) {
  const admin = state.user?.role === 'admin';
  const test = harness.lastTest ? `<span class="badge ${harness.lastTest.passed ? 'pass' : 'fail'}">최근 시험 ${harness.lastTest.passed ? 'PASS' : 'FAIL'}</span>` : '<span class="badge">미시험</span>';
  const commands = harness.commands.map((command, index) => `<li><span class="mono">${escapeHtml(command.file)} ${escapeHtml((command.args || []).join(' '))}</span><small>cwd=${escapeHtml(command.cwd || '.')} · exit=${command.expectedExit} · ${command.timeoutMs}ms</small></li>`).join('');
  const fixtures = (harness.fixtureCandidates || []).length;
  const actions = admin ? [
    `<button class="ghost" data-harness-action="test" data-harness-id="${escapeHtml(harness.id)}">시험</button>`,
    harness.status !== 'ACTIVE' ? `<button class="primary" data-harness-action="activate" data-harness-id="${escapeHtml(harness.id)}" ${harness.lastTest?.passed ? '' : 'disabled'}>활성화</button>` : '',
    harness.status === 'ACTIVE' ? `<button class="warning" data-harness-action="disable" data-harness-id="${escapeHtml(harness.id)}">비활성화</button>` : '',
  ].join('') : '';
  return `<article class="harness-card">
    <div class="harness-card-head"><div><p class="eyebrow">${escapeHtml(harness.source)} · v${harness.version}</p><h3>${escapeHtml(harness.label)}</h3><p class="mono muted">${escapeHtml(harness.id)}</p></div><span class="badge ${harness.status === 'ACTIVE' ? 'pass' : harness.status === 'DISABLED' ? 'fail' : ''}">${escapeHtml(harness.status)}</span></div>
    <p>${escapeHtml(harness.description || '설명 없음')}</p>
    <ul class="command-list">${commands}</ul>
    <div class="task-meta">${test}<span class="badge">fixture 후보 ${fixtures}</span><span class="badge mono">${escapeHtml(harness.definitionSha256.slice(0, 12))}</span></div>
    <div class="task-actions">${actions}</div>
    ${(harness.fixtureCandidates || []).length ? `<details class="details"><summary>Fixture 후보</summary><pre>${escapeHtml(JSON.stringify(harness.fixtureCandidates, null, 2))}</pre></details>` : ''}
  </article>`;
}

function renderSkillCard(skill) {
  const admin = state.user?.role === 'admin';
  const actions = admin ? [
    skill.status !== 'ACTIVE' ? `<button class="primary" data-skill-action="activate" data-skill-id="${escapeHtml(skill.id)}">활성화</button>` : '',
    skill.status === 'ACTIVE' ? `<button class="warning" data-skill-action="disable" data-skill-id="${escapeHtml(skill.id)}">비활성화</button>` : '',
  ].join('') : '';
  return `<article class="harness-card">
    <div class="harness-card-head"><div><p class="eyebrow">${escapeHtml(skill.source)} · v${skill.version}</p><h3>${escapeHtml(skill.label)}</h3><p class="mono muted">${escapeHtml(skill.id)}</p></div><span class="badge ${skill.status === 'ACTIVE' ? 'pass' : skill.status === 'DISABLED' ? 'fail' : ''}">${escapeHtml(skill.status)}</span></div>
    <p>${escapeHtml(skill.description || '설명 없음')}</p>
    <ol class="command-list">${(skill.rules || []).map((rule) => `<li>${escapeHtml(rule)}</li>`).join('')}</ol>
    <div class="task-meta"><span class="badge">실패 ${skill.sourceFailureCaseIds?.length || 0}건</span><span class="badge mono">${escapeHtml(skill.definitionSha256.slice(0, 12))}</span></div>
    <div class="task-actions">${actions}</div>
  </article>`;
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

function renderFailureRow(failure) {
  const admin = state.user?.role === 'admin';
  const canPromote = admin && failure.status !== 'FIXTURE_CANDIDATE';
  const actions = [
    canPromote ? `<button class="ghost compact" data-failure-action="promote" data-failure-id="${escapeHtml(failure.id)}">fixture 후보</button>` : '',
    failure.status !== 'RESOLVED' ? `<button class="ghost compact" data-failure-action="resolve" data-failure-id="${escapeHtml(failure.id)}">해결</button>` : `<button class="ghost compact" data-failure-action="reopen" data-failure-id="${escapeHtml(failure.id)}">재열기</button>`,
    failure.status !== 'IGNORED' ? `<button class="ghost compact" data-failure-action="ignore" data-failure-id="${escapeHtml(failure.id)}">무시</button>` : '',
  ].join('');
  return `<tr>
    <td><span class="badge ${failure.status === 'OPEN' ? 'fail' : failure.status === 'RESOLVED' ? 'pass' : ''}">${escapeHtml(failure.status)}</span></td>
    <td>${escapeHtml(failure.kind)}</td><td class="mono">${escapeHtml(failure.harnessId)}</td><td>${formatNumber(failure.occurrences)}</td><td>${escapeHtml(formatDateTime(failure.lastSeenAt))}</td>
    <td><strong>${escapeHtml(failure.title)}</strong><small class="mono">${escapeHtml(failure.id)}</small><details class="details"><summary>마지막 증거</summary><pre>${escapeHtml(JSON.stringify(failure.lastEvidence, null, 2))}</pre></details></td>
    <td><div class="inline-actions">${actions}</div></td>
  </tr>`;
}

function render() {
  renderSummary();
  board.innerHTML = columns.map(([status, label]) => {
    const tasks = state.tasks.filter((task) => task.status === status);
    return `
      <section class="column" data-status="${status}">
        <div class="column-header"><h2>${label}</h2><span class="count">${tasks.length}</span></div>
        <div class="card-list">${tasks.length ? tasks.map(renderTask).join('') : '<div class="empty">작업 없음</div>'}</div>
      </section>`;
  }).join('');
}

function renderSummary() {
  document.querySelector('#summary').innerHTML = columns.map(([status, label]) =>
    `<span>${label} ${state.tasks.filter((task) => task.status === status).length}</span>`
  ).join('');
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
  const blocked = task.blocked ? `<p class="error">막힘: ${escapeHtml(task.blocked.reason)}</p>` : '';
  const review = task.review?.comment ? `<p class="muted">리뷰: ${escapeHtml(task.review.comment)}</p>` : '';
  const criteria = renderListSection('완료 조건', task.acceptanceCriteria);
  const aiDetails = renderTaskAI(task.ai);

  return `
    <article class="task-card">
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
      </div>
      <div class="task-meta">${scope}</div>
      ${blocked}${review}
      <div class="task-actions">${renderActions(task)}</div>
      ${aiDetails}${details}
    </article>`;
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
  if (task.status === 'READY' && (!task.assigneeUserId || mine)) actions.push(actionButton(task, 'claim', '시작'));
  if (task.status === 'IN_PROGRESS' && (mine || admin)) {
    actions.push(actionButton(task, 'verify', task.verification?.status === 'RUNNING' ? '검증 중…' : '검증 실행', 'primary'));
    if (task.verification?.passed) actions.push(actionButton(task, 'request-review', '리뷰 요청'));
  }
  if (task.status === 'REVIEW' && !mine && (!task.reviewerUserId || task.reviewerUserId === state.user.id)) {
    actions.push(actionButton(task, 'approve', '승인', 'primary'));
    actions.push(actionButton(task, 'reject', '반려', 'danger'));
  }
  if (task.status !== 'DONE' && task.status !== 'BLOCKED' && participant) actions.push(actionButton(task, 'block', '막힘', 'warning'));
  if (task.status === 'BLOCKED' && participant) actions.push(actionButton(task, 'unblock', '다시 준비'));
  if (state.ai.enabled && participant && task.status !== 'DONE') actions.push(actionButton(task, 'ai-brief', 'AI 브리프'));
  if (state.ai.enabled && participant && task.verification) actions.push(actionButton(task, 'ai-verification-summary', 'AI 검증 요약'));
  return actions.join('');
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

bootstrap();
