import test from 'node:test';
import assert from 'node:assert/strict';
import { assignSkills, auditSkills } from '../src/skill-policy.js';

const document = {
  title: '검증 실행 정책 연결',
  summary: '서버와 실행 결과 검증에 스킬 자동 배정을 추가한다.',
  changes: [
    { path: 'server.js', summary: 'runtime endpoint' },
    { path: 'src/run-artifacts.js', summary: 'failure result policy' },
    { path: 'src/cli/main.js', summary: 'CLI context output' },
  ],
  appliedSkills: ['scope-guard', 'missing-skill'],
};

const skills = [
  { id: 'run-document-integrity', label: 'Run document', status: 'ACTIVE', rules: ['실제 변경 파일을 결과 문서에 기록한다.'] },
  { id: 'execution-verification', label: 'Execution', status: 'ACTIVE', rules: ['실제 명령을 실행해 검증한다.'] },
  { id: 'failure-corpus-discipline', label: 'Failures', status: 'ACTIVE', rules: ['실패 증거를 중복 없이 기록한다.'] },
  { id: 'powershell-encoding', label: 'PowerShell', status: 'ACTIVE', rules: ['PowerShell CLI 출력은 UTF-8로 확인한다.'] },
  { id: 'root-cause-diagnosis', label: 'Root cause', status: 'ACTIVE', rules: ['서버 장애의 직접 원인을 재현한다.'] },
  { id: 'scope-guard', label: 'Board scope', status: 'ACTIVE', rules: ['작업 카드의 allowedPaths와 worktree 범위를 확인한다.'] },
  { id: 'judging-score', label: 'Game judging', status: 'ACTIVE', rules: ['게임 심사 점수를 계산한다.'] },
];

test('assignSkills selects core and path-sensitive skills without board-only rules', () => {
  const policy = assignSkills(document, skills);
  const required = policy.required.map((item) => item.id);
  assert.deepEqual(required.sort(), [
    'execution-verification',
    'failure-corpus-discipline',
    'powershell-encoding',
    'root-cause-diagnosis',
    'run-document-integrity',
  ].sort());
  assert.ok(!policy.recommended.some((item) => item.id === 'scope-guard'));
  assert.ok(!policy.selected.some((item) => item.id === 'judging-score'));
  assert.ok(policy.autoAdded.includes('execution-verification'));
  assert.ok(policy.autoEnabled.includes('execution-verification'));
  assert.deepEqual(policy.autoDisabled, ['scope-guard', 'missing-skill']);
  assert.equal(policy.switches.find((item) => item.id === 'scope-guard').enabled, false);
  assert.match(policy.switches.find((item) => item.id === 'scope-guard').reason, /board-dependent/);
  assert.equal(policy.switches.find((item) => item.id === 'execution-verification').enabled, true);
  assert.ok(policy.missingRequired.includes('root-cause-diagnosis'));
  assert.deepEqual(policy.ignoredDeclared, ['missing-skill']);
});

test('auditSkills separates board-dependent and evidence-backed skills', () => {
  const audits = auditSkills([
    skills.find((item) => item.id === 'scope-guard'),
    { id: 'path-escape-qa', label: 'Path QA', status: 'ACTIVE', rules: ['경로 이탈 입력을 재현하고 차단 여부를 확인한다.'], sourceFailureCaseIds: ['case-1'] },
    { id: 'unused', label: 'Unused', status: 'ARCHIVED', rules: [] },
  ]);
  assert.equal(audits[0].grade, 'NARROW');
  assert.equal(audits[0].boardDependent, true);
  assert.equal(audits[1].grade, 'VERIFIED_SOURCE');
  assert.equal(audits[2].grade, 'INACTIVE');
});
