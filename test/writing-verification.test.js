import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const execFile = promisify(execFileCallback);
const checker = path.resolve('tools/verification/check-writing.mjs');

test('writing verifier accepts a grounded document', async () => {
  const root = await repository();
  try {
    await write(root, 'docs/proposal.md', '# 제안서\n\n## 주장과 근거\n사용자 인터뷰 결과라는 가정에 기반해 설명한다.\n\n## 결정\n작은 실험부터 시작한다.\n\n## 열린 질문\n표본을 얼마나 확보할지 결정해야 한다.\n');
    await execFile(process.execPath, [checker, 'document'], { cwd: root });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('brainstorm verifier validates candidate, comparison, recommendation, decision, and run by role', async () => {
  const root = await repository();
  try {
    await write(root, 'docs/brainstorms/candidates/001-value.md', candidate());
    await write(root, 'docs/brainstorms/001.comparison.md', '# 후보 비교\n\n## 기준 명세와 충돌\n가설 변경만 존재한다.\n\n## 공통 실패\n초기 정보가 행동을 바꾸지 못할 수 있다.\n\n## 답할 수 없는 질문\n실제 선택 빈도는 플레이테스트가 필요하다.\n');
    await write(root, 'docs/brainstorms/001.recommendation.md', '# 추천\n\n## 제품 방향 판단\n- 상태: PROTOTYPE_REQUIRED\n문서만으로 결정하지 않는다.\n\n## 다음 실험 추천\n후보 A를 시험한다.\n\n## 가장 강한 반론\n콘텐츠가 장식이 될 위험이 있다.\n\n## 차선안\n후보 B다.\n\n## 추천이 뒤집히는 조건\n실험에서 선택이 줄면 뒤집는다.\n');
    await write(root, 'docs/decisions/001.decision.md', '# 결정\n\n- 상태: 선택 대기\n\n아직 어떤 후보도 제품 방향으로 채택하지 않는다.\n\n## 열린 질문\n어느 후보를 먼저 시험하고 어떤 위험을 감수할 것인가?\n\n## 재개 조건\n사람이 후보와 허용할 명세 변경 범위를 승인하면 별도 작업으로 재개한다.\n');
    await write(root, 'docs/brainstorms/001.run.md', '# 실행 기록\n\n이 기록은 브레인스토밍 산출물과 검증 결과를 분리해 보존한다.\n\n## 변경 파일\n후보와 비교 및 추천 문서만 변경했고 제품 파일은 변경하지 않았다.\n\n## 검증 기록\n역할별 문서 검사와 변경 범위 검사를 실행하고 결과를 기록했다.\n');
    await write(root, 'docs/brainstorms/evidence/failure.txt', 'raw command failure without brainstorm headings');
    const result = await execFile(process.execPath, [checker, 'brainstorm'], { cwd: root });
    assert.doesNotMatch(result.stdout, /evidence/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('candidate must declare spec impact and open questions', async () => {
  const root = await repository();
  try {
    await write(root, 'docs/brainstorms/candidates/001-value.md', candidate().replace('## 기준 명세 영향', '## 변경 사항').replace('## 열린 질문', '## 결론'));
    await assert.rejects(execFile(process.execPath, [checker, 'brainstorm'], { cwd: root }), /기준 명세 영향.*열린 질문|spec impact.*open questions/s);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('recommendation separates product direction and next experiment with an allowed status', async () => {
  const root = await repository();
  try {
    await write(root, 'docs/brainstorms/001.recommendation.md', '# 추천\n\n## 추천안\n후보 A를 최종 선택한다.\n\n## 가장 강한 반론\n위험이 있다.\n\n## 차선안\n후보 B다.\n\n## 추천이 뒤집히는 조건\n실패하면 바꾼다.\n');
    await assert.rejects(execFile(process.execPath, [checker, 'brainstorm'], { cwd: root }), /제품 방향 판단|product direction/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('general brainstorm keeps the lightweight fallback rules', async () => {
  const root = await repository();
  try {
    await write(root, 'ideas.md', '# 아이디어 탐색\n\n## 아이디어\n- 자동 요약 방식\n- 역할 분리 방식\n- 단계별 검증 방식\n\n## 위험과 반론\n복잡성이 증가할 위험이 있다.\n\n## 선택과 열린 질문\n단계별 검증을 우선 선택하고 다음 실험에서 비용을 확인한다.\n');
    await execFile(process.execPath, [checker, 'brainstorm'], { cwd: root });
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-writing-'));
  await execFile('git', ['init', '-q'], { cwd: root });
  return root;
}
async function write(root, relative, contents) { const file = path.join(root, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, contents, 'utf8'); }
function candidate() { return '# 후보 A\n\n## 기준 명세 영향\n불변 조건 위반은 없고 현재 가설 하나를 변경한다.\n\n## 한 문장 정의\n가치를 추론해 투자한다.\n\n## 핵심 루프\n관찰하고 추론하고 입찰한다.\n\n## 가장 강한 반론\n독해 부담이 커질 수 있다.\n\n## 예상 실패\n단서가 장식이 될 위험이 있다.\n\n## 자동 검증\n필수 단서 포함 여부를 검사한다.\n\n## 최소 플레이테스트\n선택 이유를 관찰한다.\n\n## 열린 질문\n적정 단서 수는 얼마인가?\n'; }
