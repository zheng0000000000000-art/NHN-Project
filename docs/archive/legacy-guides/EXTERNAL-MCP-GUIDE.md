# Team Loop 외부 AI MCP 연결 통합 가이드

이 문서는 서버 PC와 파일시스템을 공유하지 않는 외부 PC에서 Claude Code, Codex 등의 AI 에이전트를 Team Loop에 연결하는 전체 절차를 설명한다.

외부 연결의 공식 경로는 **MCP 하나**다. 외부 PC는 서버의 절대 경로를 직접 사용하거나 공식 저장소를 직접 수정하지 않는다. 작업 조회와 결과 전달은 MCP가 담당하고, 파일 적용·검증·병합은 서버 PC가 담당한다.

## 1. 전체 구조

```text
외부 PC의 AI 에이전트
  ├─ MCP로 프로젝트 컨텍스트 조회
  ├─ MCP로 작업·스킬·하네스 조회
  ├─ 작업 claim
  ├─ 허용된 UTF-8 파일 수신
  └─ 수정 결과와 작업 보고 제출
                    ↓ HTTP
Team Loop 서버 PC (desktop-4flj7lg)
  ├─ 제출 파일의 경로·크기·기준 커밋 검사
  ├─ 서버 내부 작업별 Git worktree에 적용
  ├─ 하네스와 범위 검사 실행
  ├─ 검증 결과와 실패 사례 기록
  └─ 리뷰 승인 후 공식 저장소에 병합
```

역할을 다음처럼 구분한다.

| 구분 | 담당 |
|---|---|
| 작업 지시와 상태 관리 | MCP·작업보드 |
| 외부 AI의 결과 전달 | MCP |
| 물리적 작업 격리 | 서버의 Git worktree |
| 공식 통과 판정 | 서버의 하네스와 검증기 |
| 최종 승인 | 사람 리뷰어 |
| 공식 저장소 병합 | Team Loop 서버 |

## 2. 외부 PC에 필요한 것

- Node.js 20 이상
- Team Loop 서버에 대한 HTTP 접근
- Team Loop 사용자 계정
- MCP를 지원하는 Claude Code 또는 Codex

다음 항목은 외부 PC에 필요하지 않다.

- `team-loop-lite-ai-learning` 저장소 clone
- `unknown-auction` 저장소 clone
- 서버 PC의 `C:\NHN Project` 경로
- 서버 worktree 직접 접근
- 하네스 실행 환경 복제

MCP 실행 파일은 GitHub 저장소에서 `npx`가 임시로 받아 실행한다.

## 3. 최초 로그인

외부 PC의 PowerShell에서 다음 명령을 실행한다.

```powershell
npx --yes --package=github:zheng0000000000000-art/NHN-Project team-loop --server http://desktop-4flj7lg.tail20618c.ts.net:4173 login --name 사용자이름
```

서버 주소가 MagicDNS로 연결되지 않으면 Tailscale IP를 사용한다.

```text
http://100.124.114.72:4173
```

로그인 세션은 외부 PC 사용자 디렉터리 아래의 `.team-loop-lite`에 저장된다. MCP는 이 로그인 세션을 재사용한다.

## 4. MCP 설정

Claude Code 또는 다른 MCP 클라이언트의 설정에 다음 서버를 추가한다.

```json
{
  "mcpServers": {
    "team-loop": {
      "command": "C:\\Program Files\\nodejs\\npx.cmd",
      "args": [
        "--yes",
        "--package=github:zheng0000000000000-art/NHN-Project",
        "team-loop-mcp"
      ],
      "env": {
        "TEAM_LOOP_URL": "http://desktop-4flj7lg.tail20618c.ts.net:4173"
      }
    }
  }
}
```

Windows에서는 확장자 없는 `npx`보다 `C:\Program Files\nodejs\npx.cmd` 절대 경로를 권장한다. Node.js를 방금 설치한 경우 실행 중인 MCP 클라이언트에 새 `PATH`가 반영되지 않았을 수 있고, 일부 클라이언트는 확장자 없는 명령을 직접 실행하지 못한다. macOS와 Linux에서는 기존처럼 `"command": "npx"`를 사용한다.

설정 후 MCP 클라이언트를 다시 시작하고 `team-loop` 도구가 표시되는지 확인한다.

## 5. 외부 에이전트가 사용하는 MCP 기능

### 프로젝트와 작업 조회

- `get_project_context`: 프로젝트 목표와 공통 규칙 조회
- `list_tasks`: 작업 목록을 간략하게 조회
- `show_task`: 선택한 작업의 범위·완료 조건·검증 프로필 조회
- `list_skills`: 실패 사례에서 축적된 작업 규칙 조회
- `list_harnesses`: 사용 가능한 검증 기준 조회

### 작업 진행

- `claim_task`: 대기열에 들어간 자신의 작업 시작
- `read_task_files`: 작업 범위 안의 UTF-8 파일과 기준 커밋 수신
- `submit_task_result`: 변경 파일, 작업 요약, 학습 처리 결과 제출
- `verify_task`: 서버 worktree에서 공식 검증 실행
- `request_review_task`: 검증 통과 결과를 사람 리뷰로 전달

외부 MCP에서는 서버 파일시스템을 직접 다루는 `create_worktree`와 `remove_worktree`를 제공하지 않는다.

## 6. 표준 작업 순서

외부 AI는 다음 순서를 지킨다.

1. `get_project_context`로 프로젝트 목표와 규칙을 읽는다.
2. `list_tasks`로 작업 후보를 확인한다.
3. `show_task`로 한 작업의 `allowedPaths`, 완료 조건, 검증 프로필을 읽는다.
4. `list_skills`와 `list_harnesses`에서 적용할 규칙과 검증 기준을 확인한다.
5. 사람이 작업보드에서 해당 작업을 에이전트 대기열에 넣는다.
6. 외부 AI가 `claim_task`를 호출한다.
7. `read_task_files`로 실제로 필요한 파일만 요청한다.
8. 받은 내용을 기준으로 로컬 임시 영역에서 결과를 작성한다.
9. `submit_task_result`로 변경된 파일만 제출한다.
10. `verify_task`를 호출한다.
11. 실패하면 검증 결과를 확인하고 수정한 뒤 다시 제출한다.
12. 통과하면 `request_review_task`를 호출한다.
13. 사람 리뷰어가 작업 결과·변경 파일·검증 근거를 확인해 승인하거나 반려한다.

## 7. 결과 제출 형식

`submit_task_result`에는 다음 정보가 필요하다.

```json
{
  "taskId": "tsk_...",
  "baseCommit": "40자리 Git 커밋 SHA",
  "summary": "무엇을 왜 변경했는지 설명",
  "learningDisposition": "실패 학습을 어떻게 처리했는지 설명",
  "files": [
    {
      "path": "src/example.js",
      "content": "변경된 UTF-8 파일 전체 내용"
    },
    {
      "path": "src/old-file.js",
      "deleted": true
    }
  ]
}
```

`baseCommit`은 `read_task_files`가 반환한 값을 그대로 사용한다. 읽은 뒤 공식 프로젝트가 변경되었다면 제출이 거부되므로 파일을 다시 읽어야 한다.

`learningDisposition`에는 다음 중 하나를 명시한다.

- 기존 스킬 또는 하네스를 재사용했다.
- 새로운 재사용 가능 실패를 발견해 기록했다.
- 실패는 있었지만 일회성이어서 별도 학습 자산으로 만들지 않았다.
- 실패가 없었고 새로 승격할 학습 내용도 없었다.

최종 검증 통과가 중간 실패를 지우지는 않는다.

## 8. 서버가 제출물을 처리하는 방식

서버는 결과를 받으면 다음 순서로 처리한다.

1. 제출자와 작업 담당자가 일치하는지 확인한다.
2. 작업이 `IN_PROGRESS` 상태인지 확인한다.
3. 기준 커밋이 현재 공식 프로젝트와 같은지 확인한다.
4. 파일 경로가 작업의 `allowedPaths` 안인지 검사한다.
5. 경로 탈출, 절대경로, 바이너리, 중복 파일, 과도한 크기를 거부한다.
6. 작업 전용 서버 worktree를 만들거나 기존 MCP worktree를 재사용한다.
7. 제출 파일을 worktree에만 적용한다.
8. 지정된 하네스와 Git 범위 검사를 실행한다.
9. 통과·실패 결과와 변경 파일을 작업에 기록한다.
10. 승인 시에만 공식 브랜치에 병합한다.

외부 AI가 제출한 내용은 공식 저장소에 즉시 반영되지 않는다.

## 9. 제한과 보안 기준

현재 MCP 제출 제한은 다음과 같다.

| 항목 | 제한 |
|---|---:|
| 한 번에 제출 가능한 파일 | 최대 50개 |
| 파일 하나의 크기 | 최대 256 KiB |
| 전체 파일 내용 크기 | 최대 512 KiB |
| 파일 형식 | UTF-8 텍스트 |
| 바이너리·심볼릭 링크 | 지원하지 않음 |
| 변경 가능 경로 | 작업의 `allowedPaths` 내부 |
| 하네스·스킬 관리 | 서버 측 관리 |

이미지, 영상, 대형 빌드 파일을 Base64로 바꾸어 MCP에 넣지 않는다. 대형 에셋 전달은 추후 별도 저장소 또는 객체 저장소 연동으로 다룬다.

## 10. 반복 수정과 검증 실패

첫 제출이 검증에 실패해도 같은 작업을 이어서 수정할 수 있다.

1. `read_task_files`를 다시 호출하면 서버의 기존 MCP worktree 내용을 읽는다.
2. 실패 원인을 수정한다.
3. `submit_task_result`로 변경 파일을 다시 제출한다.
4. `verify_task`를 재실행한다.

MCP 제출로 만든 worktree만 반복 제출에 재사용한다. 서버에서 다른 방식으로 실행 중인 에이전트의 변경과는 섞지 않는다.

## 11. 자주 발생하는 오류

### 서버의 `C:\NHN Project` 경로가 외부 PC에 없다고 나오는 경우

외부 에이전트가 오래된 `create_worktree` 절차를 사용하고 있는 것이다. MCP 패키지를 다시 불러오고 `read_task_files`와 `submit_task_result`를 사용한다.

### MCP 도구가 표시되지 않는 경우

- Node.js 20 이상인지 확인한다.
- MCP 설정의 `command`가 `npx`인지 확인한다.
- `TEAM_LOOP_URL`을 확인한다.
- MCP 클라이언트를 완전히 다시 시작한다.

### `Not logged in` 오류

최초 로그인 명령을 같은 OS 사용자 계정에서 다시 실행한다. MCP 프로그램과 로그인 명령은 동일한 `.team-loop-lite` 세션을 사용해야 한다.

### `Project changed after the files were read` 오류

다른 작업이 공식 프로젝트에 병합되어 기준 커밋이 변경된 것이다. `read_task_files`로 파일과 `baseCommit`을 다시 받아 작업한다.

### `Path is outside task scope` 오류

제출 파일이 작업의 `allowedPaths`에 포함되지 않는다. 임의로 범위를 넓히지 말고 사람에게 작업 범위 조정 또는 별도 작업 생성을 요청한다.

### 검증 실패

작업 카드의 검증 결과와 실패 사례를 확인한다. 수정 후 다시 제출하고, 재사용할 수 있는 교훈이 있다면 기존 스킬·하네스 재사용 또는 실패 학습 기록으로 남긴다.

## 12. 외부 에이전트용 기본 지시문

외부 AI의 프로젝트 지시문에는 다음 원칙을 포함한다.

```text
Team Loop 연결은 MCP만 사용한다.
서버 PC의 절대 경로를 외부 PC의 로컬 경로처럼 사용하지 않는다.
공식 저장소를 직접 clone·push·merge하지 않는다.
작업 전 get_project_context, show_task, list_skills, list_harnesses를 확인한다.
read_task_files로 받은 baseCommit과 파일을 기준으로 작업한다.
allowedPaths 밖의 파일은 요청하거나 제출하지 않는다.
결과는 submit_task_result로 제출한다.
공식 통과 여부는 verify_task 결과로 판단한다.
검증 통과 후 request_review_task를 호출한다.
중간 실패도 learningDisposition에 기록한다.
```

## 13. 현재 완료된 검증

- 전체 자동 테스트 143개 통과
- GitHub에서 `npx`로 MCP 패키지를 내려받아 실행되는 것 확인
- 외부 MCP 도구 12개 노출 확인
- 외부에 서버 절대 경로가 노출되지 않는 것 확인
- 범위 밖 경로, 경로 탈출, 바이너리, 오래된 기준 커밋 거부 확인
- 서버 worktree 격리 확인
- 검증 실패 후 재조회·재제출 동작 확인
- Team Loop 서버가 `unknown-auction` workspace에 연결된 상태 확인

## 14. 이번 범위에서 제외한 기능

다음 기능은 향후 관리자 기능 또는 별도 전송 계층으로 다룬다.

- 외부 MCP에서 하네스·스킬 생성, 활성화, 삭제
- 이미지·영상·대형 바이너리 업로드
- API 토큰 발급과 세부 권한 정책
- 외부 에이전트별 제출량 제한과 조직 권한
- 대형 프로젝트 파일 검색과 스트리밍 전송

현재 단계의 원칙은 단순하다.

> 외부 AI는 MCP로 읽고 제출한다. 서버는 worktree에서 적용하고 검증한다. 사람은 결과와 근거를 리뷰한다.
