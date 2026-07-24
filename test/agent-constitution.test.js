import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

test('agent constitution defines the stable source rules for generated orchestration', async () => {
  const text = await readFile(new URL('../docs/AGENT-CONSTITUTION.md', import.meta.url), 'utf8');
  for (const section of [
    'Mission',
    'Entry protocol',
    'Minimal reading policy',
    'Decision protocol',
    'Execution and approval',
    'Work lifecycle',
    'HANDOFF protocol',
    'Performance budget',
    'Constitution change protocol',
    'Acceptance scenarios',
    'Machine-readable summary',
  ]) {
    assert.match(text, new RegExp(`## \\d+\\. ${section}`));
  }
  for (const decision of ['YES', 'NO', 'ASK', 'BLOCKED']) assert.match(text, new RegExp(`\\| \\\`${decision}\\\``));
  assert.match(text, /C-CHANGE-001/);
  assert.match(text, /C-VISIBLE-001/);
  assert.match(text, /사용자는 프로그램 사용법이 아니라 원하는 결과/);
});

test('documentation index separates current rules from historical guides', async () => {
  const index = await readFile(new URL('../docs/README.md', import.meta.url), 'utf8');
  for (const current of ['AGENT-CONSTITUTION.md', 'ENGINE-BOUNDARY.md', 'SECURITY.md', 'BRAINSTORM-WORKFLOW.md']) {
    assert.match(index, new RegExp(current.replace('.', '\\.')));
  }
  await access(new URL('../docs/archive/legacy-guides/PROJECT-INTENT-LOOP.md', import.meta.url));
  await access(new URL('../docs/archive/migrations/CONTRACT-MIGRATION.md', import.meta.url));
  await access(new URL('../docs/archive/research/LOCAL-FIRST-KNOWLEDGE-PROMOTION.md', import.meta.url));
  await access(new URL('../docs/archive/snapshots/VERIFICATION.md', import.meta.url));
});
