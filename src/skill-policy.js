import path from 'node:path';
import { readFile } from 'node:fs/promises';

const SYSTEM_SKILLS = [
  {
    id: 'run-document-integrity', label: 'Run document integrity', status: 'ACTIVE', source: 'SYSTEM',
    rules: [
      '작업 결과 문서에 실제로 변경한 제품 파일을 빠짐없이 기록한다.',
      '문서에 선언하지 않은 제품 파일 변경을 남기지 않는다.',
      '프로그램이 생성한 결과와 실패 증거는 사람이 작성한 실행 문서와 분리한다.',
    ],
  },
  {
    id: 'execution-verification', label: 'Execution verification', status: 'ACTIVE', source: 'SYSTEM',
    rules: [
      '변경 종류에 맞는 가장 강한 검증 프로필을 실행한다.',
      '검증 명령, 종료 코드, 적용 프로필을 결과에 기록한다.',
      '실행 검증이 실패하면 완료로 판정하지 않는다.',
    ],
  },
  {
    id: 'failure-corpus-discipline', label: 'Failure corpus discipline', status: 'ACTIVE', source: 'SYSTEM',
    rules: [
      '재현 가능한 실패만 안정된 서명과 함께 실패 자료에 기록한다.',
      '같은 실패 서명은 중복 사례 대신 기존 사례에 증거를 추가한다.',
      '실패에서 만든 규칙은 원본 실패 사례를 추적할 수 있어야 한다.',
    ],
  },
  {
    id: 'document-grounding', label: 'Document grounding', status: 'ACTIVE', source: 'SYSTEM',
    rules: ['주요 주장에는 근거 또는 명시적인 가정을 연결한다.', '독자와 문서 목적에 직접 필요하지 않은 내용을 제거한다.', '결정된 내용과 미해결 질문을 별도 구역으로 구분한다.'],
  },
  {
    id: 'document-consistency', label: 'Document consistency', status: 'ACTIVE', source: 'SYSTEM',
    rules: ['공유 용어는 문서 전체에서 같은 의미로 사용한다.', '요약의 결론과 본문의 근거가 서로 모순되지 않게 한다.', '숫자와 외부 사실은 출처가 없으면 가정으로 표시한다.'],
  },
  {
    id: 'brainstorm-divergence', label: 'Brainstorm divergence', status: 'ACTIVE', source: 'SYSTEM',
    rules: ['후보는 이름만 다르게 하지 말고 핵심 루프가 실제로 다르게 발산시킨다.', '각 후보에 기준 명세 영향, 가장 강한 반론, 예상 실패, 검증 방법과 열린 질문을 기록한다.', '현재 설계 가설을 불변 조건으로 오인하지 말고 변경 권한을 명시한다.'],
  },
  {
    id: 'brainstorm-synthesis', label: 'Brainstorm synthesis', status: 'ACTIVE', source: 'SYSTEM',
    rules: ['제품 방향 판단과 다음 실험 추천을 별도 섹션으로 작성한다.', '제품 방향에는 RECOMMENDED, CONDITIONAL, TIED, INSUFFICIENT_EVIDENCE, PROTOTYPE_REQUIRED, RESEARCH_REQUIRED 중 하나의 상태를 사용한다.', '추천안, 차선안, 가장 강한 반론, 추천이 뒤집히는 조건과 아직 답할 수 없는 질문을 보존한다.'],
  },
];
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', '작업', '파일', '코드', '수정', '추가', '검증']);

export async function buildSkillPolicy({ workspaceRoot, document }) {
  const [skillDb, failureDb] = await Promise.all([
    readJson(path.join(workspaceRoot, 'data', 'skills.json'), { skills: [] }),
    readJson(path.join(workspaceRoot, 'data', 'failure-cases.json'), { cases: [] }),
  ]);
  const registered = Array.isArray(skillDb.skills) ? skillDb.skills : [];
  const skills = [...new Map([...SYSTEM_SKILLS, ...registered].map((skill) => [skill.id, skill])).values()];
  const failures = Array.isArray(failureDb.cases) ? failureDb.cases : [];
  return assignSkills(document, skills, failures);
}

export function assignSkills(document, skills, failures = []) {
  const changes = Array.isArray(document.changes) ? document.changes : [];
  const contracts = document.sharedContracts || {};
  const descriptor = [document.title, document.summary, document.objective, document.audience, ...Object.values(contracts).flat(), ...changes.flatMap((item) => [item.path, item.summary])].filter(Boolean).join('\n');
  const taskTokens = tokenize(descriptor);
  const changedPaths = changes.map((item) => String(item.path || '').toLowerCase());
  const failureById = new Map(failures.map((item) => [item.id, item]));
  const active = skills.filter((item) => item.status === 'ACTIVE');
  const scored = active.map((skill) => scoreSkill(skill, taskTokens, changedPaths, failureById));
  const requiredIds = new Set(['run-document-integrity', 'execution-verification']);
  if (document.mode?.appliedMode === 'DOCUMENT') { requiredIds.add('document-grounding'); requiredIds.add('document-consistency'); }
  if (document.mode?.appliedMode === 'BRAINSTORM') { requiredIds.add('brainstorm-divergence'); requiredIds.add('brainstorm-synthesis'); }
  if (changedPaths.some((item) => item.includes('failure') || item.includes('run-artifacts'))) requiredIds.add('failure-corpus-discipline');
  if (changedPaths.some((item) => item.startsWith('src/cli/') || item.endsWith('.ps1')) || /powershell|encoding|utf-?8/i.test(descriptor)) requiredIds.add('powershell-encoding');
  if (changedPaths.some((item) => item === 'server.js' || item.includes('auth') || item.includes('security'))) requiredIds.add('root-cause-diagnosis');

  const required = scored.filter((item) => requiredIds.has(item.id)).sort((a, b) => b.score - a.score);
  const recommended = scored.filter((item) => !requiredIds.has(item.id) && item.score >= 3 && !item.audit.boardDependent && modeAllowsSkill(document.mode?.appliedMode, item.id))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 3);
  const declared = [...new Set(document.appliedSkills || [])];
  const selected = [...required, ...recommended];
  const selectedIds = selected.map((item) => item.id);
  const requiredIdList = required.map((item) => item.id);
  const recommendedIdList = recommended.map((item) => item.id);
  const switches = skills.map((skill) => {
    const enabled = selectedIds.includes(skill.id);
    let reason = 'not relevant to this run';
    if (skill.status !== 'ACTIVE') reason = `registry status is ${skill.status}`;
    else if (requiredIdList.includes(skill.id)) reason = 'required for this run';
    else if (recommendedIdList.includes(skill.id)) reason = 'relevant to this run';
    else if (auditSkill(skill).boardDependent) reason = 'board-dependent rule is disabled for run-document execution';
    return { id: skill.id, enabled, reason };
  });
  return {
    declared,
    required: required.map(publicSelection),
    recommended: recommended.map(publicSelection),
    selected: selected.map(publicSelection),
    autoAdded: selectedIds.filter((id) => !declared.includes(id)),
    autoEnabled: selectedIds.filter((id) => !declared.includes(id)),
    autoDisabled: declared.filter((id) => !selectedIds.includes(id)),
    missingRequired: required.map((item) => item.id).filter((id) => !declared.includes(id)),
    ignoredDeclared: declared.filter((id) => !active.some((skill) => skill.id === id)),
    switches,
    estimatedTokens: Math.ceil(selected.reduce((sum, item) => sum + item.rules.join('\n').length, 0) / 4),
  };
}

export function auditSkills(skills) {
  return skills.map((skill) => {
    const audit = auditSkill(skill);
    const evidence = (skill.sourceFailureCaseIds || []).length;
    const isCore = ['execution-verification', 'failure-corpus-discipline'].includes(skill.id);
    const grade = skill.status !== 'ACTIVE' ? 'INACTIVE' : audit.boardDependent || audit.tooManyRules ? 'NARROW' : evidence ? 'VERIFIED_SOURCE' : isCore ? 'CORE' : 'UNPROVEN';
    return { id: skill.id, label: skill.label, status: skill.status, grade, evidenceCases: evidence, ...audit };
  });
}

function scoreSkill(skill, taskTokens, changedPaths, failureById) {
  const rules = Array.isArray(skill.rules) ? skill.rules : [];
  const skillTokens = tokenize([skill.id, skill.label, skill.description, ...rules].join('\n'));
  let score = [...taskTokens].filter((token) => skillTokens.has(token)).length * 2;
  const reasons = [];
  const id = String(skill.id || '');
  if (id === 'run-document-integrity' || id === 'execution-verification') { score += 20; reasons.push('core run policy'); }
  for (const failureId of skill.sourceFailureCaseIds || []) {
    const failure = failureById.get(failureId);
    const evidencePath = String(failure?.lastEvidence?.file || '').toLowerCase();
    if (evidencePath && changedPaths.some((item) => item.includes(evidencePath) || evidencePath.includes(path.basename(item)))) { score += 10; reasons.push(`failure evidence ${failureId}`); break; }
  }
  if (id.includes('powershell') && changedPaths.some((item) => item.endsWith('.ps1') || item.startsWith('src/cli/'))) { score += 8; reasons.push('CLI or PowerShell path'); }
  if (id.includes('path-escape') && changedPaths.some((item) => item.includes('path') || item === 'server.js')) { score += 6; reasons.push('path-sensitive code'); }
  if (id.includes('root-cause') && changedPaths.some((item) => item === 'server.js' || item.includes('auth'))) { score += 6; reasons.push('runtime-sensitive code'); }
  if (id.includes('judging') && ![...taskTokens].some((token) => ['judging', '심사', 'game', '게임', 'video', '영상', 'nhn'].includes(token))) score -= 20;
  return { ...skill, score, reasons, audit: auditSkill(skill), rules };
}

function auditSkill(skill) {
  const rules = Array.isArray(skill.rules) ? skill.rules : [];
  const text = rules.join('\n');
  return {
    ruleCount: rules.length,
    tooManyRules: rules.length > 7,
    boardDependent: /allowedPaths|worktree|작업 카드|task claim|board/i.test(text),
    vagueRules: rules.filter((rule) => String(rule).trim().length < 24).length,
  };
}
function publicSelection(item) { return { id: item.id, label: item.label, score: item.score, reasons: item.reasons, rules: item.rules }; }
function modeAllowsSkill(mode, id) {
  if (id.startsWith('document-')) return mode === 'DOCUMENT';
  if (id.startsWith('brainstorm-')) return mode === 'BRAINSTORM';
  return true;
}
function tokenize(value) { return new Set(String(value || '').toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((item) => item.length >= 2 && !STOP_WORDS.has(item))); }
async function readJson(file, fallback) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error?.code === 'ENOENT') return fallback; throw error; } }
