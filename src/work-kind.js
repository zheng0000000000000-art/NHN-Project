// 일의 종류를 태스크 문면에서 판정한다.
//
// 쓰기 범위는 일의 크기를 예측하지 못한다. 파일 하나만 고치는 일과 파일 하나만 고치되
// 492줄짜리 참조를 읽고 그 설정 패턴을 이해해야 하는 일은 allowedPaths가 같다.
// 턴을 먹는 것은 쓰기가 아니라 읽기·이해이므로, 신호는 "써도 되는 곳" 대신
// "읽어야 하지만 쓸 수 없는 곳"에서 나온다.

const PATH_PATTERN = /(?:^|[\s"'`(\[])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,6})(?::\d+)?/g;
const EXISTENCE_ONLY = /\b(exists|is the only changed file|존재한다|생성된다)\b/i;
const COMPREHENSION = /\b(assert|asserts|drives|matches|pattern|copy the|reuse|reproduce|단언|재현|패턴)\b/i;

// glob을 리터럴 접두사로 줄인다. 비교는 경계를 지켜서 한다.
function writablePrefixes(allowedPaths) {
  return (Array.isArray(allowedPaths) ? allowedPaths : [])
    .map((entry) => String(entry).replace(/\\/g, '/').split('*')[0].replace(/\/+$/, ''))
    .filter(Boolean);
}

// 문면에 등장하는 파일 경로를 모은다.
export function referencedPaths(text) {
  const found = new Set();
  for (const match of String(text ?? '').replace(/\\/g, '/').matchAll(PATH_PATTERN)) {
    found.add(match[1]);
  }
  return [...found].sort();
}

// 쓰기가 허용되지 않은 참조만 남긴다. 이것이 읽기 부담의 대리값이다.
export function readOnlyReferences(task) {
  const text = [task?.description, ...(Array.isArray(task?.acceptanceCriteria) ? task.acceptanceCriteria : [])]
    .filter(Boolean).join('\n');
  const prefixes = writablePrefixes(task?.allowedPaths);
  return referencedPaths(text).filter((candidate) =>
    !prefixes.some((prefix) => candidate === prefix || candidate.startsWith(`${prefix}/`)));
}

// 일의 종류와 그렇게 본 근거를 함께 돌려준다. 판정만 주고 근거를 감추지 않는다.
export function classifyWorkKind(task) {
  const criteria = Array.isArray(task?.acceptanceCriteria) ? task.acceptanceCriteria : [];
  const criteriaText = criteria.join(' ');
  const reads = readOnlyReferences(task);
  const evidence = {
    readOnlyReferences: reads,
    readOnlyReferenceCount: reads.length,
    criteriaCount: criteria.length,
    criteriaCharacters: criteriaText.length,
    existenceOnly: EXISTENCE_ONLY.test(criteriaText) && !COMPREHENSION.test(criteriaText),
    comprehensionWords: COMPREHENSION.test(criteriaText),
  };
  if (evidence.existenceOnly && reads.length === 0) return { kind: 'PRODUCE_ONLY', evidence };
  if (reads.length > 0) return { kind: 'READ_THEN_PRODUCE', evidence };
  if (evidence.comprehensionWords) return { kind: 'UNDERSPECIFIED', evidence };
  return { kind: 'UNKNOWN', evidence };
}
