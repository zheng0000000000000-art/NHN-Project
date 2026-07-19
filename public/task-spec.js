function personName(users, userId, fallback) {
  return users.find((user) => user.id === userId)?.name || fallback;
}

function tableText(value) {
  return String(value ?? '').replaceAll('|', '\\|').replace(/\r?\n/g, '<br>');
}

function fileText(value) {
  return String(value || 'task')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'task';
}

function list(items, emptyText = '없음', prefix = '- ') {
  return Array.isArray(items) && items.length
    ? items.map((item) => `${prefix}${String(item)}`).join('\n')
    : `- ${emptyText}`;
}

function checklist(items, emptyText = '별도 항목 없음') {
  return list(items, emptyText, '- [ ] ');
}

function commandText(command) {
  if (!command?.file) return '';
  return [command.file, ...(command.args || [])].join(' ');
}

function statusNextStep(status) {
  return ({
    READY: '담당자가 작업을 시작하고 범위 내 결과물을 작성합니다.',
    IN_PROGRESS: '구현을 마친 뒤 완료 조건별 증거를 정리하고 검증을 실행합니다.',
    REVIEW: '리뷰어가 완료 조건, 변경 범위, 검증 결과를 확인합니다.',
    BLOCKED: '막힘 원인을 해소하거나 작업 범위와 완료 조건을 다시 합의합니다.',
    DONE: '완료된 결과를 유지하고 후속 회귀 문제가 없는지 확인합니다.',
  })[status] || '현재 상태를 확인한 뒤 다음 담당자에게 인계합니다.';
}

export function taskSpecFilename(task) {
  return `${fileText(task?.title)}-작업-명세서.md`;
}

export function buildTaskSpecMarkdown(task, users = [], generatedAt = new Date(), context = {}) {
  if (!task?.id || !task?.title) throw new TypeError('A task with id and title is required.');
  const assignee = personName(users, task.assigneeUserId, '미지정');
  const reviewer = personName(users, task.reviewerUserId, '누구나(담당자 제외)');
  const creator = personName(users, task.creatorUserId, '미상');
  const schedule = task.schedule || {};
  const profile = context.profiles?.[task.verificationProfile];
  const skills = (task.skillIds || []).map((id) => context.skills?.find((item) => item.id === id) || { id });
  const brief = task.ai?.brief || {};
  const verification = task.verification;
  const generated = generatedAt instanceof Date && !Number.isNaN(generatedAt.valueOf())
    ? generatedAt.toISOString()
    : String(generatedAt || '');
  const implementationSteps = brief.implementationSteps?.length ? brief.implementationSteps : [
    '작업 설명과 완료 조건을 읽고 기대 결과를 확인한다.',
    `허용 경로(${(task.allowedPaths || []).join(', ') || '미지정'}) 안에서만 변경한다.`,
    '완료 조건별로 구현 또는 문서 결과를 만들고 자체 점검한다.',
    `검증 프로필(${task.verificationProfile || '미지정'})을 실행한다.`,
    '변경 파일, 검증 결과, 남은 위험을 정리해 리뷰를 요청한다.',
  ];
  const reviewChecklist = brief.reviewChecklist?.length ? brief.reviewChecklist : [
    '모든 완료 조건에 대응하는 결과와 증거가 있는가?',
    '변경된 파일이 허용 경로 안에만 있는가?',
    '지정된 검증이 통과했으며 실패가 숨겨지지 않았는가?',
    '기존 기능이나 문서에 의도하지 않은 회귀가 없는가?',
    '남은 위험과 후속 작업이 명확하게 기록되었는가?',
  ];

  return `# ${task.title}

> Team Loop 상세 작업 명세서 · 생성 ${generated}

## 1. 작업 개요

| 항목 | 내용 |
|---|---|
| 작업 ID | ${tableText(task.id)} |
| 상태 / 버전 | ${tableText(task.status || 'READY')} / v${tableText(task.version ?? '-')} |
| 우선순위 | P${tableText(task.priority ?? 100)} |
| 작성자 | ${tableText(creator)} |
| 담당자 | ${tableText(assignee)} |
| 리뷰어 | ${tableText(reviewer)} |
| 계획 시작 | ${tableText(schedule.plannedStart || '미정')} |
| 계획 마감 | ${tableText(schedule.plannedEnd || '미정')} |
| 일정 메모 | ${tableText(schedule.note || '없음')} |
| 검증 프로필 | ${tableText(task.verificationProfile || '미지정')}${profile?.label ? ` (${tableText(profile.label)})` : ''} |

### 목표와 배경

${task.description || '설명이 등록되지 않았습니다. 작업 시작 전에 목표와 배경을 보완하세요.'}

### 현재 단계에서 해야 할 일

${statusNextStep(task.status)}

## 2. 작업 범위

### 변경 허용 경로

${list(task.allowedPaths)}

이 목록 밖의 파일은 수정하지 않습니다. 범위 밖 변경이 필요하면 이 작업을 임의로 확장하지 말고 별도 작업으로 분리하거나 명세를 갱신합니다.

### 예상 결과물

${checklist((task.allowedPaths || []).map((path) => `\`${path}\` 범위의 변경 결과`), '결과물 경로가 지정되지 않음')}
- [ ] 완료 조건별 검증 증거
- [ ] 리뷰어에게 전달할 변경 요약

## 3. 완료 조건과 증거

아래 항목은 모두 충족되어야 합니다. 작업자는 각 항목 아래에 확인 방법이나 캡처·테스트·파일 경로를 기록합니다.

${checklist(task.acceptanceCriteria, '완료 조건이 등록되지 않음 — 착수 전에 보완 필요')}

### 완료 조건별 증거 기록

| 번호 | 확인 결과 | 증거 또는 확인 방법 |
|---:|---|---|
${(task.acceptanceCriteria || []).length ? task.acceptanceCriteria.map((_item, index) => `| ${index + 1} | [ ] 통과 / [ ] 실패 | 작성 필요 |`).join('\n') : '| 1 | [ ] 통과 / [ ] 실패 | 완료 조건부터 작성 필요 |'}

## 4. 권장 실행 순서

${implementationSteps.map((step, index) => `${index + 1}. ${step}`).join('\n')}

## 5. 검증 계획

${profile?.description || `\`${task.verificationProfile || '미지정'}\` 프로필로 작업 결과를 검증합니다.`}

### 실행되는 검사

${profile?.commands?.length ? profile.commands.map((command) => `- [ ] \`${commandText(command)}\` → 종료 코드 ${command.expectedExit ?? 0}`).join('\n') : '- [ ] 대시보드에서 지정된 검증 프로필 실행\n- [ ] `git diff --check` 또는 동등한 변경 무결성 검사'}

### 현재 검증 상태

| 항목 | 내용 |
|---|---|
| 상태 | ${tableText(verification?.status || '미실행')} |
| 판정 | ${verification ? (verification.passed ? '통과' : '실패 또는 진행 중') : '미검증'} |
| 변경 파일 수 | ${verification?.changedPaths?.length ?? '-'} |
| 범위 위반 수 | ${verification?.scopeViolations?.length ?? '-'} |
| 실패 사례 | ${tableText(verification?.failureCaseIds?.join(', ') || '없음')} |

## 6. 적용 하네스와 스킬

### 하네스

- ID: \`${task.verificationProfile || '미지정'}\`
- 목적: ${profile?.description || '프로필 상세 설명 없음'}

### 스킬

${skills.length ? skills.map((skill) => `- \`skill:${skill.id}\`${skill.label ? ` — ${skill.label}` : ''}${skill.description ? `: ${skill.description}` : ''}`).join('\n') : '- 적용된 스킬 없음'}

## 7. 리뷰 체크리스트

${checklist(reviewChecklist)}

## 8. 위험과 미확정 사항

### 알려진 위험

${list(brief.risks, '등록된 위험 없음 — 작업 중 발견하면 인계 내용에 추가')}

### 확인이 필요한 질문

${list(brief.openQuestions, '등록된 질문 없음')}

${task.blocked?.reason ? `### 현재 막힘\n\n- ${task.blocked.reason}\n` : ''}
## 9. 인계 기록

작업 완료 후 아래 내용을 채워 리뷰어에게 전달합니다.

- 변경 요약:
- 변경 파일:
- 완료 조건별 증거:
- 실행한 검증과 결과:
- 미실행 검사와 사유:
- 남은 위험 또는 후속 작업:
- 리뷰어가 집중해서 볼 부분:

## 10. 역할별 종료 조건

### 작업자

- 완료 조건을 모두 확인하고 증거를 남깁니다.
- 변경 파일이 허용 경로 안에 있는지 확인합니다.
- 지정 검증을 통과한 뒤 인계 기록을 작성하고 리뷰를 요청합니다.

### 리뷰어

- 구현 방식의 취향보다 명세의 완료 조건과 검증 증거를 우선 확인합니다.
- 범위 위반, 누락된 조건, 회귀 위험이 있으면 구체적인 근거와 함께 반려합니다.
- 승인 시 확인한 핵심 근거를 리뷰 의견에 남깁니다.
`;
}
