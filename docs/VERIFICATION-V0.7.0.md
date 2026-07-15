# Team Loop Lite v0.7.0 검증

## 적용 기준

- 기반: `team-loop-lite-ai-learning` v0.6.1
- 지시서: Part B 외부 Claude Code/Codex 사용량 + 부록 운영 전제
- 외부 npm 의존성: 추가 없음
- 기존 서버 경유 사용량과 외부 사용량: 별도 집계

## 구현 범위

### 서버

- `POST /api/usage/external`
- 세션 인증과 `X-Team-Loop-Client`
- 사용자별 분당 4회 제한
- tool whitelist와 숫자 정규화
- 일반화된 quota window schema
- `windowId` 멱등 처리
- 부분 겹침 `409 overlapping-token-window`
- `external-usage.jsonl` append-only 토큰 창
- `external-quota.json` 최신 quota와 stream cursor
- 7/30/90일 도구·사용자·모델별 별도 집계
- `LIVE / STALE / RESET_INFERRED` 표시 판정

### 개인 CLI 수집기

- `team-loop usage status`
- `team-loop usage push`
- `team-loop usage push --daemon --interval 300`
- `team-loop usage receiver --port 4318`
- `team-loop usage capture-claude-statusline --quiet`
- Claude Code `claude_code.token.usage` OTLP/HTTP JSON 수신
- Claude statusline `rate_limits` sanitized snapshot
- Codex app-server `account/rateLimits/read`
- Claude/Codex session JSONL 방어적 토큰 폴백
- 파일 byte cursor 기반 오프라인 지연 수집
- Codex 미설치·파싱 실패의 독립 진단 처리

### 대시보드

- 사용자×도구별 quota 카드
- freshness별 시각 구분
- 외부 도구·사용자·모델별 토큰
- Team Loop 월간 예산과 미합산

### 추가 P2 보강

- 존재하지 않는 로그인 이름에도 dummy PBKDF2 수행
- 검증 완료 저장 version 충돌 1회 재시도와 ERROR fallback
- AI brief/summary 생성 후 저장 충돌 시 생성 결과를 409 details에 반환
- CLI password 노출·단일 DATA_DIR·DST 경계 문서화
- 상시 가동 PC, VPN, 절전 해제, 자동 시작, 백업, 전체 로그아웃 절차 문서화

## 제외하거나 수정한 지시

- Claude OAuth credential 파일과 비공식 usage endpoint 접근: 구현하지 않음
- 집계된 부분 중복 창의 비례 절삭: 불가능하므로 409 거부
- Codex `account/usage/read` daily/lifetime 값을 증분 토큰 창으로 변환: 이중 집계 위험 때문에 구현하지 않음
- Codex app-server 미설치 시 전체 push 실패: 구현하지 않음. 진단만 기록
- 세션 JSONL에서 프롬프트를 “읽지도 않는다”는 주장: 사용하지 않음. 로컬 JSON parse 후 usage/model 외 필드는 추출·보존·전송하지 않음

## 자동 테스트

```text
npm run check
Tests: 42
Pass: 42
Fail: 0
```

포함된 신규 시험:

- external schema clamp와 unknown tool 거부
- 동일 window 멱등 처리
- 부분 overlap fail-closed
- quota freshness 15분 경계
- reset 경과 표시 추론
- Claude/Codex 깨진 JSONL 방어 파싱
- OTLP JSON token 추출
- 오프라인 cursor 이후 지연 수집
- 로컬 OTLP receiver spool
- Codex app-server JSON-RPC quota normalize
- external endpoint 미인증 401
- collector rate limit 429

## 실제 서버·CLI E2E

```text
Alice 등록
→ Claude statusline quota 2개 capture
→ Claude session log input 12 / cached 2 / output 5
→ team-loop usage push
→ 서버 external total 17
→ 대시보드 quota window 2개
```

Codex executable이 없는 시험 환경에서는:

```text
source=codex-app-server
status=FAILED
error=spawn codex ENOENT
```

만 진단에 남고 Claude snapshot과 서버 push는 정상 완료됐습니다.

E2E 결과 샘플: `/mnt/data/team-loop-external-usage-e2e.json`

## 남은 경계

- 외부 session JSONL 포맷은 비공식 폴백이며 도구 업데이트로 깨질 수 있음
- Codex token OTel metric의 세부 이름은 공식 고정 계약으로 가정하지 않음
- quota reset 추론은 표시용이며 다른 기기 사용량을 반영하지 못함
- 서버는 단일 Node 프로세스와 단일 `DATA_DIR` 전제
- 공개 인터넷 배포는 미지원
