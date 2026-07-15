# Team Loop Lite — Failure Learning + External Usage

2명 이상이 함께 쓰는 로컬 우선 작업 관리·자동 검증·상호 리뷰 도구입니다. 이번 버전은 범위를 좁혀 **실패사례를 모아 하네스 또는 스킬로 만들고 작업에 적용하는 흐름**을 구현합니다.

```text
작업 검증 실패
→ Failure Case로 중복 집계
→ 여러 Case 선택
→ 회귀 Harness 또는 재발 방지 Skill 제작
→ 시험·활성화
→ 작업에 적용
→ 다음 AI 브리프와 프로그램 검증에 사용
```

AI가 완료를 판정하지 않습니다. 하네스 실행 결과와 별도 사람 리뷰가 완료 여부를 결정합니다.

## 구현된 범위

### 1. 실패사례 수집

다음 실패가 `data/failure-cases.json`에 구조화되어 저장됩니다.

- `EXIT_MISMATCH`
- `TIMEOUT`
- `SPAWN_ERROR`
- `VERIFICATION_ERROR`
- `SCOPE_VIOLATION`

동일 signature가 반복되면 새 Case를 만들지 않고 `occurrences`와 마지막 증거를 갱신합니다. 해결된 실패가 재발하면 자동으로 `OPEN`으로 돌아옵니다.

### 2. 실패 묶음에서 회귀 하네스 제작

선택한 실패들의 실제 명령 증거를 중복 제거해 DRAFT 하네스를 만듭니다.

```text
failure.lastEvidence.file
+ args
+ cwd
+ expectedExit
→ regression harness command
```

명령 증거가 없는 Scope-only 실패는 하네스로 만들 수 없습니다. 이런 실패는 스킬로 만들어야 합니다.

제작된 하네스는 바로 활성화되지 않습니다.

```text
DRAFT
→ 현재 WORKSPACE_ROOT에서 실제 시험
→ 동일 definition이 PASS
→ ACTIVE
→ 작업에 적용 가능
```

각 하네스에는 다음 출처가 남습니다.

```json
{
  "source": "FAILURE_DERIVED",
  "sourceFailureCaseIds": ["fail_..."],
  "fixtureCandidates": [
    {
      "sourceFailureCaseId": "fail_...",
      "replayReady": false
    }
  ]
}
```

실패 로그만으로 완전한 deterministic fixture라고 주장하지 않으며, fixture 파일과 setup이 없으면 `replayReady=false`입니다.

### 3. 실패 묶음에서 스킬 제작

선택한 실패 종류에 따라 재발 방지 규칙을 만듭니다.

예:

```text
EXIT_MISMATCH
→ 완료 전에 해당 명령을 실행하고 expected exit인지 확인한다.

TIMEOUT
→ 완료 전에 해당 검증이 제한 시간 안에 끝나는지 확인한다.

SCOPE_VIOLATION
→ 해당 경로를 수정하지 않고 allowedPaths를 다시 확인한다.
```

사용자가 `--rule` 또는 웹 폼으로 규칙을 추가할 수도 있습니다. 스킬도 `DRAFT → ACTIVE`를 거쳐야 작업에 적용됩니다.

### 4. 작업에 적용

ACTIVE 하네스와 스킬만 적용할 수 있습니다.

적용하면:

- 선택한 하네스가 작업의 `verificationProfile`이 됨
- 선택한 스킬 ID가 작업의 `skillIds`에 추가됨
- 출처 Failure Case와 버전이 `learning.applications`에 기록됨
- 이전 검증과 리뷰 결과는 무효화됨
- `DONE` 또는 `REVIEW` 작업에는 적용 불가
- 오래된 task version은 `409`로 거부

적용된 스킬 규칙은 AI 작업 브리프 입력에 포함됩니다. 현재 AI는 브리프·초안·검증 요약만 제공하며 코드 제작 Executor는 포함하지 않습니다.

## 실행

요구사항:

- Node.js 20 이상
- 검증 대상은 최소 1개 commit이 있는 Git 저장소
- 외부 npm 패키지 없음

```bash
cd team-loop-lite-ai-learning
npm run check
npm link

WORKSPACE_ROOT=/absolute/path/to/game npm start
```

PowerShell:

```powershell
cd team-loop-lite-ai-learning
npm run check
npm link

$env:WORKSPACE_ROOT = "C:\work\my-game"
npm start
```

브라우저:

```text
http://localhost:4173
```

브라우저의 **실패 학습** 탭에서 실패 Case ID 여러 개를 넣어 하네스·스킬을 제작하고 작업에 적용할 수 있습니다.

## CLI 사용법

### 실패 목록

```bash
team-loop failures --status OPEN
team-loop failure show <failure-id>
```

### 여러 실패에서 스킬 제작

```bash
team-loop learning craft \
  --type SKILL \
  --id known-regressions \
  --label "Known regressions" \
  --failure fail_001 \
  --failure fail_002 \
  --rule "완료 전에 관련 플레이 테스트도 수행한다."
```

한 Case에서 바로 시작하는 별칭도 있습니다.

```bash
team-loop failure craft fail_001 \
  --type SKILL \
  --id scope-guard \
  --label "Scope guard"
```

활성화:

```bash
team-loop skill list
team-loop skill show known-regressions
team-loop skill activate known-regressions
```

### 여러 실패에서 회귀 하네스 제작

```bash
team-loop learning craft \
  --type HARNESS \
  --id known-test-regressions \
  --label "Known test regressions" \
  --failure fail_001 \
  --failure fail_003
```

시험과 활성화:

```bash
team-loop harness test known-test-regressions
team-loop harness activate known-test-regressions
```

시험이 실패하면 활성화할 수 없습니다. 실패한 하네스 시험도 다시 Failure Case에 기록됩니다.

### 작업에 적용

```bash
team-loop learning apply <task-id> \
  --harness known-test-regressions \
  --skill known-regressions \
  --skill scope-guard
```

하네스만 또는 스킬만 적용할 수도 있습니다.

```bash
team-loop learning apply <task-id> --skill scope-guard
```

## 저장 데이터

```text
data/users.json           사용자와 password hash
data/tasks.json           작업 상태와 learning applications
data/harnesses.json       Built-in/User/Failure-derived 하네스
data/skills.json          Failure-derived 스킬 규칙
data/failure-cases.json   실패 Corpus와 연결된 학습 아티팩트
data/audit.jsonl          append-only 사건 로그
data/ai-usage.jsonl       Team Loop 서버 경유 AI 사용량
data/external-usage.jsonl 외부 Claude Code/Codex 토큰 창
data/external-quota.json  외부 도구 최신 쿼터·커서 상태
data/app-secret.key       세션 서명 키
```

## 권한과 경계

```text
FAILURE_COLLECTION=automatic
LEARNING_CRAFT_AUTHORITY=admin
HARNESS_ACTIVATION_AUTHORITY=admin
SKILL_ACTIVATION_AUTHORITY=admin
LEARNING_APPLY_AUTHORITY=task participant or admin

AI_VERIFICATION_AUTHORITY=false
AI_REVIEW_AUTHORITY=false
PROGRAM_VERIFICATION_AUTHORITY=true
SEPARATE_HUMAN_REVIEW_REQUIRED=true
```

현재 포함하지 않은 것:

- AI 코드 제작 Executor
- 작업별 Git branch/worktree
- push·PR·merge 자동화
- fixture 파일/setup 자동 생성
- 스킬 자동 승격과 자동 수정

즉 이번 버전은 **실패를 잊지 않고, 사람이 고른 실패들을 재사용 가능한 검증과 작업 규칙으로 전환해 적용하는 최소 루프**입니다.

## 보안·동시성 보강 (v0.6.1)

### 비동기 비밀번호 검증과 로그인 제한

PBKDF2는 Node 이벤트 루프를 막지 않는 비동기 API로 실행됩니다. 등록과 로그인은 IP·정규화된 사용자 이름 조합을 기준으로 분당 10회로 제한되며, 초과 요청은 `429`로 거부됩니다.

### 첫 관리자 등록

`SIGNUP_CODE` 설정을 권장합니다.

```bash
SIGNUP_CODE='팀에서 공유할 임의 문자열' npm start
```

- `SIGNUP_CODE`가 설정되어 있으면 모든 신규 등록에서 코드가 필요합니다.
- 설정하지 않으면 첫 관리자 등록은 서버 시작 후 10분 동안만 허용됩니다.
- 10분이 지난 뒤 첫 사용자가 아직 없다면 `SIGNUP_CODE`를 설정하고 서버를 재기동해야 합니다.
- 코드가 없는 상태로 시작하면 서버 로그에 경고가 출력됩니다.

### POST 요청 헤더

모든 `POST /api/*` 요청은 다음 헤더 중 하나를 요구합니다.

```text
X-Team-Loop-Client: web | cli | collector
```

기본 웹 UI와 CLI는 이미 이 헤더를 전송합니다. 직접 API를 호출할 때도 반드시 추가해야 합니다.

### 검증 동시 실행

같은 `WORKSPACE_ROOT`에서는 검증을 한 번에 하나만 실행합니다. 검증 중 다른 요청이 들어오면 대기열에 넣지 않고 다음 오류로 즉시 거부합니다.

```text
409 Another verification is already running.
```

### 검증 fingerprint 경계

리뷰 요청과 승인 상태 변경의 Store lock 안에서 fingerprint를 다시 확인합니다. 이는 작업 상태 경쟁을 막지만, IDE나 외부 프로세스의 파일 쓰기와 완전한 원자성을 제공하지는 않습니다. 완전한 해결은 향후 `verifiedCommit`과 리뷰 대상 Git commit을 결속하는 방식입니다.

### 운영 경계

- 같은 `DATA_DIR`를 여러 서버 프로세스가 동시에 사용하지 마십시오. 현재 락은 단일 Node 프로세스 안에서만 유효합니다.
- CLI의 `--password` 인자와 `TEAM_LOOP_PASSWORD`는 프로세스 목록 또는 셸 히스토리에 노출될 수 있습니다. 대화형 입력을 우선 사용하십시오.
- DST가 있는 time zone에서는 “최근 N일” 그래프의 날짜 경계가 달력 기준과 일부 다를 수 있습니다. 기본 `Asia/Seoul`은 DST를 사용하지 않습니다.


## 외부 Claude Code / Codex 사용량 (v0.7.0)

외부 도구 사용량은 Team Loop 서버 경유 AI 사용량과 **절대 합산하지 않습니다**. 대시보드에서 참고용 별도 섹션으로만 표시하며 작업 상태·월간 예산·완료 판정에 영향을 주지 않습니다.

### 수집 구조

```text
개인 PC의 Claude Code / Codex
  ├─ 공식 OTLP/HTTP JSON → 로컬 receiver → sanitized spool
  ├─ Claude statusline stdin → sanitized quota snapshot
  ├─ Codex app-server JSON-RPC → quota snapshot
  └─ 세션 JSONL → 토큰 폴백
                  ↓
        team-loop usage push
                  ↓
       Team Loop 공유 서버
```

서버는 개인 계정 자격증명을 보관하거나 provider API를 대신 호출하지 않습니다.

### 1. 로그인

수집기는 기존 개인 CLI 세션을 그대로 사용합니다.

```bash
team-loop --server http://team-server:4173 login --name Alice
```

cron이나 작업 스케줄러에서도 같은 `TEAM_LOOP_CLI_HOME`을 지정하면 별도 raw cookie 복사가 필요 없습니다.

### 2. Claude Code 공식 OTel 연결

먼저 로컬 OTLP JSON receiver를 실행합니다.

```bash
team-loop usage receiver --host 127.0.0.1 --port 4318
```

Claude Code 실행 환경:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_METRICS_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://127.0.0.1:4318/v1/metrics
export OTEL_LOG_USER_PROMPTS=0
export OTEL_LOG_ASSISTANT_RESPONSES=0
claude
```

수집기는 `claude_code.token.usage`의 토큰 수·모델·종류만 저장합니다. Metrics payload에 프롬프트 본문은 포함되지 않으며, logs endpoint를 사용할 때도 API request 토큰 필드만 추출합니다.

공식 참고: https://code.claude.com/docs/en/monitoring-usage

### 3. Claude 잔여 한도

Claude Code statusline 명령으로 아래 명령을 등록합니다.

```bash
team-loop usage capture-claude-statusline --quiet
```

Claude Code가 statusline JSON을 stdin으로 전달하면 명령은 `rate_limits.five_hour`와 `rate_limits.seven_day` 숫자만 개인 CLI 디렉터리에 저장합니다. OAuth credential 파일은 읽지 않습니다.

공식 참고: https://code.claude.com/docs/en/statusline

### 4. Codex 잔여 한도

`team-loop usage push`는 로컬의 공식 `codex app-server`를 시작하고 다음 안정 API를 조회합니다.

```text
account/rateLimits/read
```

App Server가 설치되지 않았거나 로그인되어 있지 않으면 Codex 쿼터만 생략하고 다른 수집은 계속합니다. 오류는 진단 목록에 남지만 push 전체를 실패시키지 않습니다.

공식 참고: https://developers.openai.com/codex/app-server

### 5. 서버로 push

한 번 실행:

```bash
team-loop usage push
```

5분 간격 상주:

```bash
team-loop usage push --daemon --interval 300
```

수집 커서는 다음에 저장됩니다.

```text
~/.team-loop-lite/usage-cursor.json
```

컴퓨터가 꺼져 있었던 동안의 세션 로그는 다음 push에서 커서 이후 라인을 지연 수집합니다. 깨진 줄과 알 수 없는 포맷은 건너뜁니다.

### 중복·겹침 정책

- 동일 `windowId` 재전송: 멱등 성공, 추가 집계 없음
- 새 창의 시작이 이전 창 끝보다 이전: `409 overlapping-token-window`
- 집계된 토큰 창은 부분 구간을 수학적으로 분리할 수 없으므로 임의 비례 계산하지 않음

### 쿼터 freshness

- `LIVE`: 마지막 수집 15분 이내
- `STALE`: 15분 초과, 아직 알려진 reset 이전
- `RESET_INFERRED`: 15분 초과이며 알려진 reset 시각 경과. 표시만 0%로 추론

`RESET_INFERRED`는 표시용입니다. 다른 기기나 웹에서 같은 구독을 사용한 내역은 반영하지 못합니다.

### 프라이버시 한계

OTel metrics가 우선입니다. 세션 JSONL 폴백에서는 로컬 프로세스가 각 줄을 JSON으로 파싱하지만 usage·model 외 필드를 추출·보존·전송하지 않습니다. 프롬프트와 응답 본문은 로그나 서버 요청에 포함하지 않습니다.

## 상시 운영 전제

- 서버는 팀 대표의 상시 가동 PC에서 실행합니다. PC가 꺼지면 팀 서비스도 중단됩니다.
- 외부 접속은 Tailscale 같은 VPN 오버레이만 사용하고 공인 인터넷에 직접 노출하지 않습니다.
- 시스템 절전·최대 절전을 끄고, 부팅 시 자동 시작을 등록하십시오. 화면 꺼짐은 무관합니다.
- `data/`를 정기 백업하십시오.
- 전체 세션을 긴급 무효화하려면 서버를 중지하고 `data/app-secret.key`를 삭제한 뒤 재시작하십시오.
- 공용 PC에서는 시크릿/프라이빗 브라우저 창을 사용하십시오.

### Windows 작업 스케줄러 예시

서버 시작 프로그램에 다음을 등록합니다.

```powershell
powershell.exe -NoProfile -Command "cd C:\team-loop; $env:WORKSPACE_ROOT='C:\game'; npm start"
```

수집기는 각 팀원 PC에서 로그인한 `TEAM_LOOP_CLI_HOME`을 유지한 채 5분마다 실행합니다.

```powershell
team-loop usage push
```

### systemd 예시

```ini
[Unit]
Description=Team Loop Lite
After=network-online.target

[Service]
WorkingDirectory=/opt/team-loop
Environment=WORKSPACE_ROOT=/srv/game
Environment=SIGNUP_CODE=change-me
ExecStart=/usr/bin/npm start
Restart=always

[Install]
WantedBy=multi-user.target
```

## 공개 인터넷 이전 시

현재 버전은 LAN/VPN용입니다. 공개 인터넷으로 옮기기 전에는 HTTPS, `SECURE_COOKIES=true`, `SIGNUP_CODE` 강제, 서버 측 세션 관리, 원격 Git commit 기반 검증, 백업 자동화와 다중 인스턴스 저장소를 별도 설계해야 합니다.
