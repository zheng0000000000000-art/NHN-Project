# Team Loop 도구 레인 핸드오프

작성일: 2026-07-25

이 문서는 `GPT-핸드오프-툴레인.md`를 프로그램이 직접 읽을 수 있는 현재 핸드오프로 정리한 것이다. 원문의 주장 중 저장소에서 다시 확인된 사실만 실행 기준으로 사용한다.

## 현재 방향

- Team Loop는 개인 슈퍼바이저용 AI 경험·밸런싱·오케스트레이션 도구다.
- 반복 계산과 판정은 결정론적 프로그램 경로를 사용하고, AI는 계약 작성·결과 해석·코드 변경에 사용한다.
- 동적 작업 상태는 작업보드와 작업별 HANDOFF가 담당한다. 이 문서는 프로젝트 레벨의 현재 작업 방향만 전달한다.

## 확인된 상태

- 밸런스 엔진은 이미 목표 지표의 `minimum`, `maximum`, `weight`를 읽고 위반·점수·통과 여부를 계산한다.
- 이 판정은 이제 `balance-gate` 검증 프로파일과 명령 종료 코드로 노출된다.
- `src/auction-policy-comparison.js`와 테스트는 Git에 추적되어 있으며 관련 작업은 병합되었다.
- 프로젝트 컨텍스트는 현재 개인용 슈퍼바이저 방향으로 갱신되었다.
- Claude CLI의 캐시 토큰과 `total_cost_usd`가 계측기까지 보존된다.
- 깨끗한 CLI HOME에서도 서버 테스트가 고정 fixture를 사용해 재현된다.
- 작업별 누적 토큰·비용 예산이 실패 횟수와 별도로 자동 실행을 정지시킨다.
- 헌법의 중복 규칙 ID와 저장소의 줄바꿈 정책을 정리했다.
- `loop_enter`는 이 문서를 `requiredContext`에 자동 첨부한다.
- `delegate_work`는 다른 AI 프로필에 실행·검토 작업을 맡기며 중복 활성 위임 재사용, 최대 깊이 2, 토큰·비용·호출 예산 상속을 서버에서 강제한다.

## 실행 우선순위

1. 경제 파라미터와 목표 계약을 분리하되, 스키마 불일치는 해당 밸런스 실행만 실패시킨다.
2. 정책 비교 verdict는 사람의 플레이가 뒤처졌다는 사실을 곧바로 가격 오류로 단정하지 않고 추가 실험 필요 신호로 기록한다.
3. 토큰·비용 예산의 기본값을 실제 사용 기록에 맞춰 조정하고 작업별 override UI를 제공한다.

## 완료 조건

- 새 AI 세션이 MCP의 `project_handoff_read(projectId="team-loop-tool-lane")` 한 번으로 이 문서와 SHA-256을 받는다.
- 반환된 SHA-256이 프로그램이 읽은 실제 파일과 일치한다.
- 파일이 없거나 workspace 밖을 가리키면 조용히 대체하지 않고 오류로 종료한다.

## W2 입력 도착 — economy-params.json

게임 레인이 그레이박스에서 기계 추출한 경제 상수 초안이 도착했다. 스키마를 상상해서 만들지 말고 이 파일을 기준으로 작업한다.

- 경로: `workspaces/team-loop-tool-lane/inbox/economy-params.json`
- SHA-256: `e6c3a42bcce654845d25838cd976e29bd7dc9abbbd1205be895c0281610f3501`
- 크기: 24589 바이트 · `schemaVersion` 1.0.0 · 값 리프 126개

파일이 이미 담고 있는 것: 슬래시 경로 표기(밸런스 스펙 `parameterSpace.path`와 같은 표기), `tunable`/`structural` 분류, `derived`(저장하지 말고 계산해야 하는 값), `provenanceDefault` + 경로별 `provenance` 사이드카, 그리고 `crosswalk` — 이 저장소의 `examples/balance/unknown-auction-economy.json` baseline과 항목별로 대조한 결과다.

`crosswalk`의 `exact` 27건은 게임 레인에서 실제 값 비교로 검증했다. 두 레인이 §16 핵심(시작 자산, 일수, 수수료, E[M], 등급 기저가·수요 밴드, 로트 수, 시작가율, 최소 인상률, 감정가율)에서 이미 일치한다는 뜻이다. 이 27건은 바로 단일 출처로 묶어도 된다.

`divergent`와 `unmapped`는 묶지 말 것. 특히 봇 모델은 두 레인이 서로 다른 모형을 쓰고 있어서(게임: 2축 uplift/capMarket/k/rho/lam, 도구: circumstance*/interestThreshold/marketBidRatio) 기계적 동기화가 불가능하다.

`openQuestions` 4건은 사람의 결정을 기다리는 항목이다. 값을 지어내지 말고 발주자 회신 전까지는 비워 둔다.

- `curve-exponent` — 의도 자산곡선 지수가 day-1인지 day인지. 12일차가 40.5×인지 56.7×인지가 갈린다.
- `leakage-threshold` — 누출 잔차 합격선 0.30(게임) vs 0.35(도구). `balance-targets.json`에 들어갈 값이다.
- `bot-model-unification` — 두 봇 모델을 합칠지, 시뮬을 근사로 인정하고 분리 유지할지.
- `promotion-deadlock` — 상회 1→2 승급의 의뢰 요구. 현재 파라미터로는 스윕이 2단계 이후를 탐색할 수 없다.

`balance-targets.json`은 이 파일에 들어 있지 않다. 의도한 분리다 — 합격선과 파라미터가 한 화면에 있으면 빨간불이 떴을 때 골대를 옮기는 게 파라미터를 고치는 것보다 쉬워진다.
