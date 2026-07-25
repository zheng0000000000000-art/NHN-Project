import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 실측 2026-07-25: 두 번의 승인이 모두 adminOverride: true로 기록됐다. 실제로는 독립 AI
// 리뷰가 APPROVE를 낸 뒤 사람이 확정한 것인데, 기록만 보면 관리자가 검수를 건너뛴 것과
// 구분되지 않는다. reviewerProfileId는 배정된 프로필일 뿐 리뷰가 돌았다는 증거가 아니다.
// 주체와 근거를 기록에서 읽을 수 없으면 다음 사람이 프록시로 추측하게 된다.
const SERVER = await readFile('server.js', 'utf8');

function reviewRecord() {
  const from = SERVER.indexOf("status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',");
  assert.ok(from > 0, 'the review record must still be findable');
  return SERVER.slice(from, SERVER.indexOf("if (decision === 'APPROVE') {", from));
}

test('the approval records what the independent review actually concluded', () => {
  const record = reviewRecord();
  assert.match(record, /independentReview:/);
  assert.match(record, /next\.aiReview\?\.status === 'COMPLETED'/,
    'only a completed review counts as evidence that one happened');
  assert.match(record, /verdict: next\.aiReview\.verdict \?\? null/);
  assert.match(record, /reviewedAt: next\.aiReview\.reviewedAt \?\? null/);
});

test('no independent review is recorded as absent, not as a pass', () => {
  const record = reviewRecord();
  // 삼항의 else 가지가 null이어야 한다. 빈 객체나 true면 없는 검수가 있었던 것처럼 읽힌다.
  assert.match(record, /\?[\s\S]*?:\s*null,\s*\n\s*\};/,
    'a task approved with no AI review must show null');
});

test('a human overriding a rejection is visible rather than silent', () => {
  assert.match(reviewRecord(), /overriddenByHuman: decision === 'APPROVE' && next\.aiReview\.verdict === 'REJECT'/,
    'approving over a REJECT must leave a trace; it is allowed but not hidden');
});

test('the profile field alone is no longer the only provenance', () => {
  const record = reviewRecord();
  const profileAt = record.indexOf('reviewerProfileId: next.reviewerProfileId');
  const provenanceAt = record.indexOf('independentReview:');
  assert.ok(profileAt >= 0 && provenanceAt > profileAt,
    'the assigned profile stays, but what actually ran is recorded beside it');
});
