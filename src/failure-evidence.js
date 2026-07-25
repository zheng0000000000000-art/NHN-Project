// 실패 증거가 실체인지 프록시인지 판정하는 단일 출처.
//
// 하네스를 만들거나 승격 점수를 매기기 전에 반드시 물어야 하는 것: 이 판정의 근거 데이터가
// 어디에 있는가, 실체인가 프록시인가. 근거가 없는데 점수만 높으면 하네스는 검증 도구가 아니라
// 오보 증폭기가 된다. delivery gate가 남기는 EXECUTOR_FAILED/NO_DELIVERABLE 레코드는 진짜
// 명령 check와 모양이 같지만 그 file은 실행 파일이 아니라 라벨이라, 그대로 쓰면 하네스는
// spawn ENOENT로만 끝나고 승격 점수는 실행 가능한 근거가 있는 것처럼 부풀려진다.

export const SYNTHETIC_FAILURE_KINDS = new Set(['EXECUTOR_FAILED', 'NO_DELIVERABLE']);
export const SYNTHETIC_COMMAND_FILES = new Set(['agent-executor', 'agent-delivery']);

// 실패 케이스가 다시 실행 가능한 명령 근거를 가졌는지 판정한다.
export function isRerunnableFailure(failure) {
  const evidence = failure?.lastEvidence ?? {};
  const file = String(evidence.file ?? '').trim();
  if (!file) return false;
  if (SYNTHETIC_FAILURE_KINDS.has(String(failure?.kind ?? ''))) return false;
  if (SYNTHETIC_COMMAND_FILES.has(file)) return false;
  if (evidence.spawnError === true) return false;
  return true;
}

// 근거의 성격을 한 낱말로 돌려준다. 승격 후보에 실어 사람이 판정 이유를 볼 수 있게 한다.
export function evidenceBasis(cases) {
  const list = Array.isArray(cases) ? cases : [cases];
  if (list.some((item) => isRerunnableFailure(item))) return 'REPLAYABLE_COMMAND';
  if (list.some((item) => item?.lastEvidence?.paths?.length || item?.lastEvidence?.changedPaths?.length)) return 'OBSERVED_STATE';
  return 'REPORTED_OUTCOME';
}
