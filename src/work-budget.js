// 조립된 팩을 보고 턴 상한을 정한다.
//
// 지금까지는 팩보다 먼저 상한이 상수 12로 박혔다. 같은 일이 12턴에서 두 번, 24턴에서 한 번
// 빈손으로 끝났고 40턴에서 한 번에 끝났다. 턴을 먹는 것은 쓰기가 아니라 읽기·이해다.
//
// 처음에는 "팩에 쓰기 불가 소스가 있으면 읽기 작업"으로 갈랐는데, 실측에서 무너졌다.
// experienceEngine.prepare는 태스크가 지목한 파일을 넣는 것이 아니라 관련도 검색으로
// 주변 코드를 끌어온다. 그래서 읽을 것이 없는 작업도 소스를 3개 받았고, 지목한 파일이
// 있는 작업이 오히려 2개를 받았다. 존재 여부는 판별력이 없다.
//
// 그리고 더 중요한 것: maxTurns는 소비되는 예산이 아니라 상한이다. 5턴에 끝나는 일은
// 상한이 12든 40이든 5턴만 쓴다. 실제 지출은 automationGuard의 토큰·비용 예산이 막는다.
// 상한을 낮게 잡아 얻는 것은 없고, 잃은 것은 세 번의 빈손 실행이었다.
import { writablePrefixes } from './work-kind.js';

// 관측된 근거만 둔다. 값을 바꾸는 것은 사람 결재다.
export const TURN_CEILING = {
  value: 40,
  evidence: 'Work that produced nothing at 12 and again at 24 finished in one run at 40. '
    + 'A ceiling is not spend: a run that finishes in five turns costs five turns either way.',
};

// 팩에 실제로 들어온 소스 중 이 작업이 쓸 수 없는 것. 상한을 가르지는 못하지만,
// 관측에 남겨 두면 나중에 무엇이 실제로 턴을 먹었는지 대조할 수 있다.
export function readOnlySources(pack, allowedPaths) {
  const sources = pack?.sources?.sources ?? pack?.sources ?? [];
  const prefixes = writablePrefixes(allowedPaths);
  return (Array.isArray(sources) ? sources : [])
    .map((item) => String(item?.path ?? '').split('\\').join('/').trim())
    .filter(Boolean)
    .filter((candidate) => !prefixes.some((prefix) => candidate === prefix || candidate.startsWith(`${prefix}/`)));
}

// 팩 사실과 함께 상한을 돌려준다. 지금은 하나의 상한을 쓰되, 무엇을 보고 정했는지 남긴다.
export function decideWorkBudget({ pack, allowedPaths = [] } = {}) {
  const reads = [...new Set(readOnlySources(pack, allowedPaths))];
  const packSources = pack?.sources?.sources;
  return {
    maxTurns: TURN_CEILING.value,
    // 팩이 말해준 사실. 상한을 가르는 데 쓰지는 않지만 기록한다.
    readOnlySourceCount: reads.length,
    readOnlySources: reads.slice(0, 20),
    packSourceCount: Number(pack?.sources?.sourceCount ?? (Array.isArray(packSources) ? packSources.length : 0)) || 0,
    packEstimatedTokens: Number(pack?.sources?.estimatedTokens ?? 0) || 0,
    // 팩 사실로 상한을 가르는 규칙은 아직 없다. 있는 척하지 않는다.
    discriminator: 'NONE_VALIDATED',
    provisional: true,
    evidence: TURN_CEILING.evidence,
  };
}
