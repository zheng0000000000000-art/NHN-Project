# Balance engine operations

밸런스 엔진은 AI와 UI가 동일한 실험 계약을 사용하되 계산, 저장, 조회 비용을
서로 분리한다.

## Execution lifecycle

```text
QUEUED -> RUNNING -> COMPLETED
                   -> FAILED
                   -> CANCELLED
RUNNING + restart -> INTERRUPTED -> resume -> RUNNING
```

- 시뮬레이션은 Worker thread에서 실행한다.
- API는 작업 ID를 즉시 반환한다.
- 작업 상태에는 phase, completed, total과 완료된 experiment ID가 포함된다.
- 실행 요청은 `data/balance-jobs.json`에 저장되어 재시작 후 재개할 수 있다.
- 런 수와 후보 수는 각각 최대 5,000으로 제한한다.
- 시드는 최대 50개로 제한한다.

## Result storage

```text
data/balance-experiments/
  index.json
  bal_<id>/
    summary.json
    diagnostics.json
    raw.json
```

- 목록은 index와 summary만 읽는다.
- AI 기본 응답은 summary만 사용한다.
- 지표 또는 정책을 조사할 때 diagnostics를 선택 조회한다.
- 재현이나 패치 적용에 정확한 원본이 필요할 때만 raw를 읽는다.
- 기존 `data/balance-experiments.json`은 최초 초기화 시 새 구조로 가져온다.

## Search strategy

1. 전체 범위에서 균등하게 broad search를 수행한다.
2. 현재 최선 후보 주변 한 step을 local refinement한다.
3. 남은 예산은 넓은 범위의 미방문 후보로 채운다.
4. 단일 최선 후보와 함께 최대 20개의 Pareto 후보를 보존한다.
5. `priorParameters`가 있으면 이전 실험 후보를 가장 먼저 평가한다.

수치 승격은 하나의 평균이 아니라 시드별 분포, 실패율, 정책 비교와 목표 위반을
함께 통과해야 한다.

## MCP reading policy

1. `balance_run`
2. `balance_job_read`
3. 완료 후 `balance_result_read(view=summary)`
4. 실패하거나 경계에 가까운 지표만 `diagnostics + metricId`
5. 정책의 시간축이 필요할 때만 `diagnostics + policyId`
6. 정확한 전체 증거가 필요한 경우에만 `raw`

이 순서를 따르면 일반적인 실행에서 전체 원본을 AI 컨텍스트에 적재하지 않는다.
