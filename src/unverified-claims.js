// 모델이 Y/N을 주장하고 있는 자리를 찾는다.
//
// Y/N으로 답할 수 있는 질문은 프로그램이 답해야 한다. 모델은 설득되고 자기가 한 일을 좋게 보지만
// exit code는 그러지 않는다. 그래서 모델 보고에 "통과했다 / 전부 잡혔다 / exit 0" 같은 판정이
// 들어 있는데 대응하는 프로그램 검증이 없으면, 그건 하네스가 있어야 할 자리가 비어 있다는 뜻이다.
//
// 실측 근거: 코덱스가 "exit 0, 10개 전부 caught"라고 보고했고 재실행 결과는 exit 1이었다.

// 모델 문장에서 판정 주장을 잡는 표지. 서술이 아니라 판정을 노린다.
const CLAIM_PATTERNS = [
  { id: 'EXIT_CODE', pattern: /\bexit(?:s|ed)?\s*(?:code\s*)?[`'"]?\b0\b/i },
  { id: 'ALL_PASSED', pattern: /\b(?:all|every)\b[^.\n]{0,40}\b(?:pass(?:ed|es)?|caught|green)\b/i },
  { id: 'VERIFIED', pattern: /\b(?:verified|confirmed|검증(?:했|됨|完)|확인했)\b/i },
  { id: 'TESTS_PASS', pattern: /\b\d+\s*\/\s*\d+\b[^.\n]{0,20}\b(?:pass|caught)\b|\btests?\s+pass(?:ed|ing)?\b/i },
  { id: 'NO_FAILURES', pattern: /\b(?:0|no|zero)\s+(?:fail(?:ures|ing|ed)?|errors?)\b/i },
];

// 보고 문면에서 Y/N 주장을 모은다.
export function claimsIn(text) {
  const source = String(text ?? '');
  return CLAIM_PATTERNS
    .filter((candidate) => candidate.pattern.test(source))
    .map((candidate) => ({ id: candidate.id, excerpt: excerptFor(source, candidate.pattern) }));
}

// 주장이 나온 자리를 짧게 인용한다. 판정을 감추지 않기 위해서다.
function excerptFor(source, pattern) {
  const match = source.match(pattern);
  if (!match) return null;
  const start = Math.max(0, source.indexOf(match[0]) - 40);
  return source.slice(start, start + 160).replace(/\s+/g, ' ').trim();
}

// 그 주장을 실제로 뒷받침하는 프로그램 검증이 있었는지 본다.
// 자기보고가 아니라 하네스가 남긴 exit code만 증거로 친다.
export function programEvidence(verification) {
  const checks = Array.isArray(verification?.checks) ? verification.checks : [];
  const real = checks.filter((check) => check?.spawnError !== true && Number.isInteger(check?.actualExit));
  return {
    checkCount: real.length,
    passedCount: real.filter((check) => check.passed === true).length,
    verdict: verification?.passed === true ? 'PASSED' : verification?.passed === false ? 'FAILED' : null,
  };
}

// 보고와 증거를 맞대어, 프로그램이 답했어야 할 자리를 돌려준다.
export function unverifiedClaims({ report, verification, source = null } = {}) {
  const claims = claimsIn(report);
  const evidence = programEvidence(verification);
  const backed = evidence.checkCount > 0 && evidence.verdict !== null;
  return {
    source,
    claims,
    evidence,
    // 주장은 있는데 프로그램 판정이 없으면 하네스가 빠진 자리다.
    missingHarness: claims.length > 0 && !backed,
    // 주장과 프로그램 판정이 어긋나면 자기보고가 틀린 것이다. 더 나쁘다.
    contradicted: claims.length > 0 && evidence.verdict === 'FAILED',
  };
}
