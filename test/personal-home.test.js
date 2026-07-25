import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('personal loop home exposes orchestration panels and real learning feeds', async () => {
  const [html, app] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  ]);

  for (const id of ['home-goal', 'home-balance', 'home-context', 'home-learning', 'home-experiences', 'home-promotions']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /오늘의 루프/);
  assert.match(app, /\/api\/experience\/recent\?limit=8/);
  assert.match(app, /\/api\/wiki\?status=CANDIDATE&limit=8/);
  assert.match(app, /function renderPersonalHome\(\)/);
});

test('balance lab is contract-seeded and distribution-first', async () => {
  const [html, app] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  ]);
  for (const id of ['balance-preset', 'balance-parameters', 'balance-metrics', 'balance-distributions', 'balance-patch', 'balance-history']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(html, /미지의 연구소 전투/);
  assert.match(app, /\/api\/balance\/seeds/);
  assert.match(app, /failureRate/);
  assert.match(app, /p10/);
  assert.match(app, /p90/);
});

test('context studio exposes seeded packs, integrity lock, receipts, and comparison', async () => {
  const [html, app] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  ]);
  for (const id of ['context-seed', 'context-pack-history', 'context-pack-lock', 'context-pack-receipt', 'context-pack-compare']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /\/api\/context-packs\/prepare/);
  assert.match(app, /\/lock/);
  assert.match(app, /includedInModelRequest/);
  assert.match(app, /renderContextPackComparison/);
});

test('learning dashboard exposes optimistic promotion and automatic rollback controls', async () => {
  const [html, app] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  ]);
  for (const id of ['promotion-panel', 'promotion-policy', 'promotion-candidates', 'promotion-receipts', 'promotion-scan', 'promotion-audit']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /\/api\/promotions/);
  assert.match(app, /ROLLED_BACK/);
});

test('personal home exposes the shared project entry and work-ledger console', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const id of ['entry-console', 'entry-revision', 'entry-projects', 'entry-works', 'entry-work-detail']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="constitution-status"/);
});

test('workboard exposes PM plan progress and dependency-aware tasks', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="plan-overview"/);
  assert.match(html, /id="start-next-work"/);
  assert.match(app, /function renderPlanOverview/);
  assert.match(app, /dependsOnTaskIds/);
  assert.doesNotMatch(html, /id="new-task-button"|id="ai-assistant-button"|id="milestone-toggle"/);
  assert.match(html, /WORK HISTORY CALENDAR/);
  assert.match(html, /읽기 전용 이력/);
  assert.doesNotMatch(app, /'claim', '직접 시작'|'queue-agent', '에이전트 대기'|'verify', '검증 실행'/);
});

test('workboard start launches an agent worker instead of a fake human transition', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /executionMode:\s*'AGENT',\s*launchWorker:\s*true/);
  assert.doesNotMatch(app, /projectId:\s*'team-loop',\s*executionMode:\s*'HUMAN'/);
  assert.match(app, /자동 작업자 시작/);
});

test('workboard exposes a live auditable worker trace', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /LIVE WORK TRACE/);
  assert.match(app, /lastHeartbeatAt/);
  assert.match(app, /PID \$\{worker\.pid\}/);
  assert.match(app, /function taskTrace/);
  assert.match(app, /검증 통과/);
});

test('plan progress retains archived completed tasks', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(app, /state\.tasks\.filter\(\(item\) => item\.planId\)/);
  assert.doesNotMatch(app, /state\.tasks\.filter\(\(item\) => item\.planId && !item\.archived\)/);
  assert.match(server, /next\.archived = true/);
  assert.match(server, /autoArchived: decision === 'APPROVE'/);
});

test('workboard exposes executor selection and an honest usage preview', async () => {
  const [html, app] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="worker-routing-mode"/);
  assert.match(html, /id="worker-executor"/);
  assert.match(html, /id="worker-routing-preview"/);
  assert.match(app, /\/api\/orchestration\/preview-next/);
  assert.match(app, /공식 잔여 할당량은 제공되지 않아/);
});

test('workboard can stream important changes to desktop notifications', async () => {
  const [html, app, server] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../server.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="enable-work-notifications"/);
  assert.match(app, /new EventSource\('\/api\/events\/work'\)/);
  assert.match(app, /Notification\.requestPermission/);
  assert.match(app, /검증 통과/);
  assert.match(app, /자동 작업 중단/);
  assert.match(server, /Content-Type': 'text\/event-stream/);
  assert.match(server, /streamWorkEvents/);
});
