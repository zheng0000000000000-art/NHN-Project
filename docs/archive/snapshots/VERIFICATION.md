# Verification Report — Failure Learning

검증일: 2026-07-15

## 자동 테스트

```text
npm run check
→ exit 0
→ tests 27
→ pass 27
→ fail 0
```

검증 항목:

- 반복 실패 signature 중복 집계
- `RESOLVED` 실패 재발 시 `OPEN` 재개
- 여러 실패 Case에서 스킬 규칙 제작
- `EXIT_MISMATCH`와 `SCOPE_VIOLATION` 규칙 생성
- 여러 출처 Failure Case ID 보존
- 명령 실패에서 회귀 하네스 제작
- Scope-only 실패의 하네스 제작 거부
- Failure-derived 하네스의 출처와 fixture candidate 결속
- DRAFT 하네스·스킬의 작업 적용 거부
- 하네스 시험 PASS 후 활성화
- 스킬 활성화
- ACTIVE 하네스·스킬의 작업 적용
- 적용 시 기존 verification 무효화
- 적용 시 source failure IDs와 artifact versions 기록
- 적용된 스킬 규칙의 AI 작업 브리프 전달
- 기존 인증·세션·stale task version 회귀
- 기존 timeout·exit·Git scope 검증 회귀
- 기존 AI structured output·사용량 집계 회귀

## 실제 서버·CLI E2E

폐기 가능한 Git 저장소와 별도 data directory를 사용했습니다.

```text
1. Alice 관리자 등록
2. node-project 작업 생성·Claim
3. 의도적으로 실패하는 node:test 실행
4. task verify → CLI exit 2
5. EXIT_MISMATCH Failure Case 생성
6. 같은 Case에서 regression-guard Skill 제작
7. Skill ACTIVE
8. 같은 Case에서 regression-harness 제작
9. 테스트 코드를 수정해 회귀 명령 PASS
10. Harness test PASS → ACTIVE
11. Harness와 Skill을 기존 작업에 적용
```

최종 확인:

```json
{
  "harness": "regression-harness",
  "skills": ["regression-guard"],
  "verificationCleared": true
}
```

## Fail-closed 확인

```text
명령 증거 없는 Scope-only 실패 → HARNESS 제작 거부
미시험 DRAFT 하네스 → 작업 적용 거부
DRAFT 스킬 → 작업 적용 거부
DONE 작업 → 적용 거부
REVIEW 작업 → 적용 거부
오래된 task version → 409
```

## 판정 경계

```text
FAILURE_CASE_SELF_REPORT_TRUSTED=false
FAILURE_DERIVED_HARNESS_AUTO_ACTIVE=false
HARNESS_ACTIVATION_REQUIRES_MACHINE_TEST=true
FAILURE_DERIVED_SKILL_AUTO_ACTIVE=false
ACTIVE_ARTIFACT_REQUIRED_FOR_APPLICATION=true
APPLY_INVALIDATES_OLD_VERIFICATION=true
SKILL_RULES_REACH_AI_BRIEF=true
AI_COMPLETION_AUTHORITY=false
PROGRAM_VERIFICATION_AUTHORITY=true
```

## 알려진 경계

- 회귀 하네스는 실패 증거에 남은 명령을 재사용합니다. command evidence가 없는 실패는 스킬로만 전환됩니다.
- fixture candidate에는 출처와 기대 결과가 결속되지만, fixture 파일·setup·cleanup 자동 생성은 없습니다.
- 스킬 규칙은 AI 작업 브리프에 적용되며, 실제 코드 제작 AI Executor는 아직 없습니다.
- 하네스는 현재 서버의 단일 `WORKSPACE_ROOT`에서 실행됩니다.
- 작업별 Git branch/worktree와 PR 자동화는 포함되지 않았습니다.
