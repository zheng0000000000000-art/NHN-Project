import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRunMode } from '../src/run-mode.js';
import { normalizeRunDocument, selectVerificationProfile } from '../src/run-artifacts.js';
import { assignSkills } from '../src/skill-policy.js';

test('AUTO mode distinguishes code, documents, and brainstorming', () => {
  assert.equal(resolveRunMode({ title: 'API 수정' }, ['src/api.js']).appliedMode, 'CODE');
  assert.equal(resolveRunMode({ title: '결과 문서 기록 기능' }, ['src/api.js', 'docs/result.md']).appliedMode, 'CODE');
  assert.equal(resolveRunMode({ title: '제품 제안서' }, ['docs/proposal.md']).appliedMode, 'DOCUMENT');
  assert.equal(resolveRunMode({ title: '아이디어 발산' }, ['docs/brainstorm/**']).appliedMode, 'BRAINSTORM');
  assert.equal(resolveRunMode({ mode: 'DOCUMENT', title: 'Anything' }, ['src/a.js']).appliedMode, 'DOCUMENT');
});

test('normalized document mode is stable and selects its verification profile', () => {
  const document = normalizeRunDocument({ id: 'proposal-run', title: 'Product proposal', mode: 'AUTO', changes: [{ path: 'docs/proposal.md' }], verification: { profile: 'repository-basic' } });
  assert.equal(document.mode.appliedMode, 'DOCUMENT');
  assert.equal(normalizeRunDocument(document).mode.appliedMode, 'DOCUMENT');
  assert.equal(selectVerificationProfile('repository-basic', document.writeScope, document.mode.appliedMode).appliedProfile, 'document-review');
});

test('document and brainstorm modes enable different required skills', () => {
  const skills = [
    { id: 'run-document-integrity', label: 'Run', status: 'ACTIVE', rules: [] },
    { id: 'execution-verification', label: 'Verify', status: 'ACTIVE', rules: [] },
    { id: 'document-grounding', label: 'Ground', status: 'ACTIVE', rules: [] },
    { id: 'document-consistency', label: 'Consistent', status: 'ACTIVE', rules: [] },
    { id: 'brainstorm-divergence', label: 'Diverge', status: 'ACTIVE', rules: [] },
    { id: 'brainstorm-synthesis', label: 'Synthesize', status: 'ACTIVE', rules: [] },
  ];
  const base = { title: 'Writing', summary: '', objective: '', audience: '', sharedContracts: {}, changes: [{ path: 'docs/a.md', summary: '' }], appliedSkills: [] };
  const docs = assignSkills({ ...base, mode: { appliedMode: 'DOCUMENT' } }, skills).required.map((item) => item.id);
  const ideas = assignSkills({ ...base, mode: { appliedMode: 'BRAINSTORM' } }, skills).required.map((item) => item.id);
  assert.ok(docs.includes('document-grounding') && !docs.includes('brainstorm-divergence'));
  assert.ok(ideas.includes('brainstorm-divergence') && !ideas.includes('document-grounding'));
  const code = assignSkills({ ...base, mode: { appliedMode: 'CODE' } }, skills).selected.map((item) => item.id);
  assert.ok(!code.some((id) => id.startsWith('document-') || id.startsWith('brainstorm-')));
});
