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
