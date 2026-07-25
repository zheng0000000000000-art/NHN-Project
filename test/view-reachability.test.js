import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 실측: AI 로그 뷰는 모듈·테스트·API 라우트·렌더러·섹션이 모두 있고 switchView의 허용
// 목록에도 들어 있었지만, 그 뷰로 전환시키는 버튼이 없어 영원히 hidden이었다. 대화 뷰도
// 같은 상태였다. 07-18 병합 실패 뒤 사람이 손으로 다시 심으면서 입구만 빠뜨린 결과다.
// 화면에 도달할 수 있는지는 Y/N으로 판정되므로 사람 눈이 아니라 여기서 잡는다.
const HTML = await readFile('public/index.html', 'utf8');
const APP = await readFile('public/app.js', 'utf8');

// switchView가 받아들이는 뷰 이름을 코드에서 그대로 읽는다(목록을 여기 베껴 두면 어긋난다).
function acceptedViews() {
  const line = APP.match(/state\.activeView = \[([^\]]*)\]\.includes\(view\)/);
  assert.ok(line, 'switchView must keep declaring the views it accepts');
  return [...line[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

// 클릭으로 그 뷰에 도달할 수 있는 요소가 있는지 본다. switchView는 이 두 속성에서만 불린다.
function reachableViews() {
  const found = new Set();
  for (const source of [HTML, APP]) {
    for (const m of source.matchAll(/data-(?:loop-)?view="([a-z-]+)"/g)) found.add(m[1]);
  }
  return found;
}

test('every view switchView accepts can actually be reached by a click', () => {
  const reachable = reachableViews();
  const stranded = acceptedViews().filter((view) => !reachable.has(view));
  assert.deepEqual(stranded, [],
    'these views are wired and rendered but nothing can navigate to them');
});

test('switchView is only reachable through the attributes this test inspects', () => {
  // 다른 진입로가 생기면 위 검사가 조용히 헐거워진다. 호출부를 세어 잠근다.
  const callSites = [...APP.matchAll(/(function\s+)?switchView\(([^)]*)\)/g)]
    .filter((m) => !m[1])
    .map((m) => m[2].trim());
  assert.ok(callSites.length >= 3, 'the known navigation paths must still be present');
  for (const arg of callSites) {
    assert.ok(
      ['button.dataset.view', 'target.dataset.loopView', 'state.activeView'].includes(arg),
      `switchView(${arg}) is a navigation path this test does not check — extend reachableViews()`,
    );
  }
});

test('the two views that were stranded stay reachable', () => {
  const reachable = reachableViews();
  // 회귀 방지: 이 둘이 빠진 채로 몇 달을 갔다.
  assert.ok(reachable.has('ai-logs'), 'the AI session log viewer needs its tab');
  assert.ok(reachable.has('discussion'), 'the discussion board needs its tab');
});
