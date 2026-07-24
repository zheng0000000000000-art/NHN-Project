# Team Loop documentation

이 디렉터리는 현재 시스템을 운용할 때 읽어야 하는 문서와 역사적 기록을 분리한다.

## Start here

1. [Agent Constitution](./AGENT-CONSTITUTION.md)  
   AI와 오케스트레이션의 최상위 원칙, 진입·판정·승인·작업·HANDOFF 계약을 정의한다.
2. [Engine Boundary](./ENGINE-BOUNDARY.md)  
   개인용 오케스트레이션 엔진과 외부로 공유되는 작업보드의 제품·데이터 경계를 정의한다.
3. [Security](./SECURITY.md)  
   코드에서 약화할 수 없는 인증, 권한, 실행 격리와 배포 안전 경계를 설명한다.
4. [Brainstorm Workflow](./BRAINSTORM-WORKFLOW.md)  
   제품 변경 전에 후보를 분리하고 비교·검증하는 현행 탐색 워크플로우다.
5. [Balance Operations](./BALANCE-OPERATIONS.md)
   비동기 실험, 진행률·재개, 결과 아티팩트와 AI의 단계적 조회 규칙을 정의한다.

## Reading policy

- 새 AI 세션은 이 목록 전체를 자동으로 읽지 않는다.
- 평상시에는 컴파일된 헌법 정책과 Project Entry를 사용한다.
- 관련 기능을 실행하거나 규칙 충돌을 해석할 때만 해당 문서를 읽는다.
- `archive`는 현재 지침으로 사용하지 않는다.

## Archive

`archive`에는 삭제하지 않고 보존한 완료된 계획, 대체된 운영 가이드, 이관 기록과 시점별 검증 자료가 있다.

- `archive/legacy-guides`: 현재 헌법과 진입 프로토콜로 대체된 사용법과 초기 제품 의도
- `archive/migrations`: Local-First Dashboard 병합과 계약 정렬 과정
- `archive/research`: 현재 기능의 근거가 된 초기 연구와 후보 정책
- `archive/snapshots`: 특정 버전의 벤치마크, 심사 기준과 검증 결과
- `archive/daily`: 날짜별 작업 기록

아카이브 문서의 명령, 경로, 도구 목록과 목표는 현재 구현과 다를 수 있다. 역사적 근거가 필요할 때만 읽는다.
