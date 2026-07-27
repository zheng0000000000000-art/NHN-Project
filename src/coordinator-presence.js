import { readFile } from 'node:fs/promises';

// 조율자가 지금 일하고 있는지 본다.
//
// 왜 필요한가: 대화 채널은 조율자를 깨우지 못한다. 조율자는 채팅으로만 턴이 시작된다.
// 2026-07-27 실측 — 사용자가 05:14:47에 글을 남겼는데 조율자 턴은 05:14:11에 이미 끝나 있었고
// 334분 동안 아무도 읽지 않았다. 사람이 물어봐서 알았다.
//
// 그래서 **글을 쓰는 순간** 조율자가 도는지 알려준다. 15분 주기 감시자는 뒷받침일 뿐이다.
//
// 판정은 하트비트 파일의 나이 하나다. 프로세스 존재로 판정하지 않는다 —
// 프로세스가 살아 있어도 일을 안 할 수 있고, 그건 "돌고 있다"의 증거가 아니다.
const DEFAULT_HEARTBEAT = 'C:\\NHN Project\\_ops\\coordinator-heartbeat.json';
const DEFAULT_STALE_MINUTES = 25;

export async function readCoordinatorPresence({
  heartbeatPath = process.env.COORDINATOR_HEARTBEAT || DEFAULT_HEARTBEAT,
  staleMinutes = Number(process.env.COORDINATOR_STALE_MINUTES) || DEFAULT_STALE_MINUTES,
  now = new Date(),
} = {}) {
  let beat;
  try {
    beat = JSON.parse(await readFile(heartbeatPath, 'utf8'));
  } catch {
    // 하트비트를 못 읽으면 살아 있다고 말하지 않는다. 모르는 것은 통과가 아니다.
    return { known: false, alive: false, ageMinutes: null, note: null };
  }
  const at = Date.parse(beat?.at ?? '');
  if (!Number.isFinite(at)) return { known: false, alive: false, ageMinutes: null, note: null };
  const ageMinutes = Math.max(0, Math.round((now.getTime() - at) / 60000));
  return { known: true, alive: ageMinutes < staleMinutes, ageMinutes, note: beat?.note ?? null };
}

// 조율자가 안 돌고 있을 때 보낼 문구. 무엇을 해야 하는지까지 적는다 —
// "안 읽힘"만 알려주면 사람이 무엇을 할지 모른다.
export function absenceNotice(presence) {
  if (!presence.known) return '조율자 하트비트를 읽을 수 없다. 이 글은 지금 읽히지 않는다 — 채팅으로 깨워야 한다.';
  return `조율자가 ${presence.ageMinutes}분째 조용하다. 이 글은 지금 읽히지 않는다 — 채팅으로 깨워야 한다.`
    + (presence.note ? ` 마지막 작업: ${presence.note}` : '');
}
