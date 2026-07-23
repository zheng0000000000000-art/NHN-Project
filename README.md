# Team Loop Lite AI

Team Loop의 중심은 개인 오퍼레이터가 사용하는 AI 밸런싱·루프
오케스트레이션 엔진입니다. 외부에 공유하는 표면은 작업보드로 제한하며,
내부 프롬프트·모델 선택·검증·학습 기록은 작업보드 출력에 포함하지 않습니다.

로그인된 CLI에서 네트워크 연결 없이도 열 수 있는 단일 HTML 작업보드를
내보낼 수 있습니다.

```powershell
team-loop board export --output workboard.html
```

엔진 경계와 공개 데이터 규칙은 [docs/ENGINE-BOUNDARY.md](docs/ENGINE-BOUNDARY.md)를
참고하세요.

## 에이전트 경험 루프

MCP는 Team Loop의 주 에이전트 인터페이스입니다. 에이전트는 작업 전에
`experience_prepare`로 위키·관련 소스·과거 실패·스킬·하네스를 포함한
컨텍스트팩을 준비하고, 작업 후 `experience_reflect`로 결과와 발견을
기록합니다. 발견한 지식은 자동 확정되지 않고 검토 가능한 위키 후보로
남습니다.

```text
experience_prepare → 작업·검증 → experience_reflect → 지식·학습 후보
```

AI 작업을 격리된 Git worktree에서 실행하고, 프로젝트 하네스로 검증한 뒤, 사람이 승인해야 기본 브랜치에 반영하는 로컬 우선 작업 루프입니다.

핵심 원칙:

- 작업 보드는 사람이 남은 일과 담당자를 확인하는 용도로만 사용합니다.
- AI 실행의 진실 공급원은 `.team-loop/runs`의 작업 문서와 `.team-loop/results`의 불변 시도 기록입니다.
- 실패는 사례로 축적하고, 재현 가능한 것은 하네스로, 행동 규칙은 스킬로 승격합니다.

## 빠른 시작

Node.js 20 이상과 Git 저장소가 필요합니다.

```powershell
npm install
npm link
cd C:\path\to\your-project
team-loop init
team-loop work "검색 기능 추가"
```

실제 AI 작업을 시작하려면 `--execute`를 붙입니다.

```powershell
team-loop work "검색 기능 추가" --execute --executor codex
```

통과한 결과는 자동 병합되지 않습니다. 결과와 커밋을 검토한 다음 승인합니다.

```powershell
team-loop run land <run-id>
```

## 외부 프로젝트 초기화

`team-loop init`은 프로젝트 종류를 감지해 다음 파일을 만듭니다.

- `.team-loop/project.json`: 소스·테스트·문서 범위와 기본 정책
- `.team-loop/verification-profiles.json`: 감지된 test/lint/build 명령
- `.gitignore` 항목: 결과, lease, 학습 로그, 임시 worktree

Node, Python, Go, Rust를 감지합니다. 외부 프로젝트에서는 해당 프로젝트의 검증 프로필을 사용하며 Team Loop 자체 E2E 하네스를 실행하지 않습니다.

## 실행 수명주기

```text
작업 문서 → 범위 lease → 격리 worktree → 하네스 검증
          → 검증 커밋 준비 → 사람 승인(run land) → 반영
```

각 검증은 `.team-loop/results/<run-id>/attempt-000001.json` 형태로 추가되며 덮어쓰지 않습니다. `latest.json`은 최신 시도를, `events.jsonl`은 승인 대기와 반영 이벤트를 기록합니다.

## 문서와 브레인스토밍

목표 문구와 대상 경로로 CODE, DOCUMENT, BRAINSTORM 모드를 자동 선택합니다. 대시보드는 적용 모드를 표시합니다. 문서 모드는 구조·링크·placeholder를, 브레인스토밍은 대안 다양성·반론·종합·열린 질문을 검사합니다.

## 서버와 대시보드

```powershell
npm start
team-loop serve --workspace C:\path\to\your-project --port 4173
```

기본 주소는 `http://localhost:4173`입니다. 대시보드는 작업 현황, 실행 결과, 적용 모드, 선택된 스킬과 하네스, 실패 학습 상태를 읽기 중심으로 보여줍니다.

## 개발 검증

```powershell
npm run check
```

보안 격리가 필요한 하네스는 Docker sandbox를 켤 수 있습니다.

```powershell
$env:TEAM_LOOP_SANDBOX = "docker"
npm run check
```

Docker 모드에서는 네트워크와 자원을 제한하며 Docker가 없으면 fail-closed로 중단합니다.

## 현재 저장 방식의 한계

JSON 쓰기는 임시 파일과 rename으로 원자적으로 처리됩니다. 동일 데이터 디렉터리를 여러 서버 프로세스가 동시에 수정하는 완전한 다중 프로세스 트랜잭션은 아직 지원하지 않으므로 데이터 디렉터리당 서버 프로세스 하나를 사용하세요.

상세 설계는 [프로젝트 의도와 루프](docs/PROJECT-INTENT-LOOP.md)를 참고하세요.
