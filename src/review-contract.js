// AI 리뷰 응답에서 판정과 근거 문장을 뽑아내는 순수 파서.
// 배경(실측 4회): 프롬프트가 출력 형식을 문면으로 보여주면 리뷰어는 diff를 열지 않고 그
// 형식 문자열을 그대로 돌려준다. 예시 문구를 바꿔도 새 문구를 베꼈고, JSON 골격을 보여주자
// 골격을 베꼈다. 형식을 아예 보여주지 않고 산문으로 물었을 때만 실제로 diff를 읽고 답했다.
// 그래서 조립은 모델에게 시키지 않고 여기서 프로그램이 한다.

// 변경 파일을 "새로 만든 것"과 "고친 것"으로 가른다.
// 배경(실측 8회): 리뷰어에게 `git diff HEAD~1`을 돌리라고 시켰는데, 새로 만든 파일은
// 아직 어느 커밋에도 없어서 그 diff에 나오지 않는다. 리뷰어는 시킨 대로 보고 "테스트가
// 없다"고 정확히 판정했다 — 틀린 것은 리뷰어가 아니라 우리가 보여준 증거였다.
// 게다가 HEAD~1은 이 작업과 무관한 이전 커밋까지 끌고 온다.
export function partitionChangedPaths(porcelain, changedPaths) {
  const untracked = new Set();
  for (const line of String(porcelain ?? '').split(/\r?\n/)) {
    if (!line.startsWith('??')) continue;
    const file = line.slice(2).trim().replace(/^"|"$/g, '');
    if (file) untracked.add(file.replace(/\\/g, '/'));
  }
  const created = [];
  const modified = [];
  for (const raw of Array.isArray(changedPaths) ? changedPaths : []) {
    const file = String(raw || '').replace(/\\/g, '/').trim();
    if (!file) continue;
    (untracked.has(file) ? created : modified).push(file);
  }
  return { created, modified };
}

// 판정 한 단어만 있는 줄인지 본다. 굵게·마침표 같은 장식은 벗겨서 비교한다.
export function verdictOnLine(line) {
  const bare = String(line ?? '')
    .replace(/[*_`#>\s]/g, ' ')
    .trim()
    .replace(/[.!:,]+$/, '')
    .trim()
    .toUpperCase();
  if (bare === 'APPROVE' || bare === 'REJECT') return bare;
  return null;
}

// 판정 줄로도, 근거 문장으로도 쓸 수 없는 줄인지 본다(빈 줄·구분선·머리표).
function isNoise(line) {
  const text = String(line ?? '').trim();
  if (!text) return true;
  if (/^[-=_*\s]+$/.test(text)) return true;
  if (/^#{1,6}\s/.test(text)) return true;
  if (/^(step\s*\d|verdict|summary|concerns)\b/i.test(text.replace(/^[-*\s]+/, ''))) return true;
  return false;
}

// 목록 기호·굵게 표시를 벗겨 근거 문장만 남긴다.
function cleanSentence(line) {
  return String(line ?? '')
    .replace(/^[-*\d.)\s]+/, '')
    .replace(/\*\*/g, '')
    .trim();
}

// 산문 응답에서 판정·근거·우려를 조립한다. 형식을 지키라고 시키는 대신 여기서 읽어낸다.
export function parseReviewProse(output) {
  const lines = String(output ?? '').split(/\r?\n/);
  let verdictAt = -1;
  let verdict = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const found = verdictOnLine(lines[i]);
    if (found) {
      verdict = found;
      verdictAt = i;
      break;
    }
  }
  if (!verdict) return { verdict: null, summary: '', concerns: [], reason: 'NO_VERDICT_LINE' };

  let summary = '';
  for (let i = verdictAt - 1; i >= 0; i -= 1) {
    if (isNoise(lines[i])) continue;
    if (verdictOnLine(lines[i])) continue;
    summary = cleanSentence(lines[i]);
    if (summary) break;
  }
  if (!summary) return { verdict, summary: '', concerns: [], reason: 'NO_SUMMARY_LINE' };

  return {
    verdict,
    summary,
    concerns: verdict === 'REJECT' ? [summary] : [],
    reason: null,
  };
}
