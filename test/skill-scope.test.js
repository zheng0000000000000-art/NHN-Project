import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SkillRegistry } from '../src/skill-registry.js';
import { HarnessRegistry } from '../src/harness-registry.js';

// 한 프로젝트에서 승격된 지식이 다른 프로젝트 에이전트에게도 규칙으로 실리면 안 된다.
// 2026-07-27 관측: 경매 프로젝트의 심사 스킬 4개가 전역 스킬 목록에 섞여 있었다.
async function registryWith(skills) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'skill-scope-'));
  await writeFile(path.join(directory, 'skills.json'), JSON.stringify({ schemaVersion: 1, skills }), 'utf8');
  return { directory, registry: new SkillRegistry({ dataDirectory: directory }) };
}

const SKILLS = [
  { id: 'global-rule', label: 'g', status: 'ACTIVE', rules: [], scope: 'global' },
  { id: 'legacy-no-scope', label: 'l', status: 'ACTIVE', rules: [] },
  { id: 'auction-only', label: 'a', status: 'ACTIVE', rules: [], scope: 'unknown-auction' },
  { id: 'toolchain-only', label: 't', status: 'ACTIVE', rules: [], scope: 'team-loop-lite-ai-learning' },
];

test('a workspace sees global skills and its own, not another project\'s', async (t) => {
  const { directory, registry } = await registryWith(SKILLS);
  t.after(() => rm(directory, { recursive: true, force: true }));

  const ids = (await registry.list({ workspaceId: 'unknown-auction' })).map((item) => item.id);
  assert.deepEqual(ids, ['auction-only', 'global-rule', 'legacy-no-scope']);
  assert.ok(!ids.includes('toolchain-only'), 'another project rule must not leak in');
});

test('the other workspace gets the mirrored answer', async (t) => {
  const { directory, registry } = await registryWith(SKILLS);
  t.after(() => rm(directory, { recursive: true, force: true }));

  const ids = (await registry.list({ workspaceId: 'team-loop-lite-ai-learning' })).map((item) => item.id);
  assert.deepEqual(ids, ['global-rule', 'legacy-no-scope', 'toolchain-only']);
  assert.ok(!ids.includes('auction-only'));
});

// 소속을 안 주면 거르지 않는다. 관리 화면과 감사에는 전부 보여야 하기 때문이다.
test('omitting the workspace returns every skill, so audits still see all of them', async (t) => {
  const { directory, registry } = await registryWith(SKILLS);
  t.after(() => rm(directory, { recursive: true, force: true }));

  const ids = (await registry.list()).map((item) => item.id);
  assert.equal(ids.length, 4);
});

// scope가 없는 기존 기록을 조용히 감추면 규칙이 사라진 것을 아무도 모른다.
test('a record without a scope stays visible instead of silently disappearing', () => {
  assert.equal(SkillRegistry.visibleIn({ id: 'x' }, 'unknown-auction'), true);
  assert.equal(SkillRegistry.visibleIn({ id: 'x', scope: 'global' }, 'unknown-auction'), true);
  assert.equal(SkillRegistry.visibleIn({ id: 'x', scope: 'other' }, 'unknown-auction'), false);
  assert.equal(SkillRegistry.visibleIn({ id: 'x', scope: 'other' }, null), false);
});

// 승격이 소속을 안 찍으면 다음 실패 하나로 오염이 돌아온다.
test('a skill promoted from failure is stamped with the workspace it came from', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'skill-scope-promote-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'skills.json'), JSON.stringify({ schemaVersion: 1, skills: [] }), 'utf8');

  const registry = new SkillRegistry({ dataDirectory: directory, workspaceId: 'unknown-auction' });
  const created = await registry.createFromFailures(
    { id: 'usr_test' },
    { id: 'derived-rule', label: 'Derived', rules: ['do not repeat the failure'] },
    [{ id: 'fail_1', title: 'boom' }],
  );

  assert.equal(created.scope, 'unknown-auction');
  const leaked = (await registry.list({ workspaceId: 'team-loop-lite-ai-learning' })).map((item) => item.id);
  assert.ok(!leaked.includes('derived-rule'), 'a failure from one project must not become another project\'s rule');
});

// 하네스도 같은 규칙이다 — 한 프로젝트의 실패에서 나온 검사가 다른 프로젝트에 실리면 안 된다.
test('harness scope hides another project\'s checks and stamps promoted ones', () => {
  assert.equal(HarnessRegistry.visibleIn({ id: 'h' }, 'unknown-auction'), true);
  assert.equal(HarnessRegistry.visibleIn({ id: 'h', scope: 'global' }, 'unknown-auction'), true);
  assert.equal(HarnessRegistry.visibleIn({ id: 'h', scope: 'unknown-auction' }, 'unknown-auction'), true);
  assert.equal(HarnessRegistry.visibleIn({ id: 'h', scope: 'unknown-auction' }, 'team-loop-lite-ai-learning'), false);
});
