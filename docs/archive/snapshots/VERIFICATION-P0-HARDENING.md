# v0.6.1 P0/P1 보강 검증

## 적용 범위

- A-1: 비동기 PBKDF2, 인증 rate limit
- A-2: 사용량 JSONL metadata cache, `Intl.DateTimeFormat` cache, 이벤트별 date key 1회 계산
- A-3: workspace 단위 verify mutex
- A-4: 리뷰 요청·승인 직전 Store lock 안 fingerprint 재확인 및 STALE version 보정
- A-5: 첫 관리자 10분 bootstrap window와 `SIGNUP_CODE` 경고/검사
- A-6: 모든 POST API의 `X-Team-Loop-Client` 필수화

## 명시적 경계

A-4는 task-state 경쟁을 줄였지만 외부 프로세스의 파일 쓰기까지 원자적으로 잠그지는 않는다. Git `verifiedCommit` 결속은 후속 작업이다.

Part B 외부 Claude Code/Codex 수집은 공식·비공식 데이터 계약 수정이 필요하므로 이번 변경에 포함하지 않았다.

## 자동 검증

```text
npm run check
tests: 33
pass: 33
fail: 0
```

추가 검증:

- 잘못된 비밀번호 PBKDF2 8건이 실행 중인 동안 `/api/health` 응답이 250ms 이내
- 동일 IP+이름 인증 요청 11번째가 429
- 헤더 없는 POST가 403
- 같은 workspace의 두 번째 verify가 409이며 큐잉되지 않음
- 10,000건 사용량 cold summary 80.026ms, warm 7회 median 8.626ms (`docs/BENCHMARK-P0.json`)
- 외부 JSONL append 후 cache invalidation 및 10,001건 재집계
- 첫 관리자 bootstrap window 만료 및 signup code 양성/음성
