function safeFilename(value) {
  return String(value || 'task')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'task';
}

function personName(users, userId, fallback = '미지정') {
  return users.find((user) => user.id === userId)?.name || fallback;
}

function commandText(check) {
  return [check?.file, ...(check?.args || [])].filter(Boolean).join(' ');
}

export function taskResultFilename(task) {
  return `${safeFilename(task?.title)}-작업-결과.md`;
}

export function taskResultSummary(task) {
  const verification = task?.verification;
  if (!verification) return '아직 제출된 검증 결과가 없습니다.';
  const changedCount = verification.changedPaths?.length || 0;
  const checks = verification.checks || [];
  const passedCount = checks.filter((check) => check.passed).length;
  const verdict = verification.passed ? '검증 통과' : '검증 실패';
  return `${verdict} · 변경 파일 ${changedCount}개 · 검사 ${passedCount}/${checks.length}개 통과`;
}

export function buildTaskResultMarkdown(task, users = [], generatedAt = new Date()) {
  if (!task?.id || !task?.title) throw new TypeError('A task with id and title is required.');
  const verification = task.verification;
  const executor = verification?.executor || task.executor;
  const generated = generatedAt instanceof Date ? generatedAt.toISOString() : String(generatedAt || '');
  const changedPaths = verification?.changedPaths || [];
  const checks = verification?.checks || [];
  const criteria = task.acceptanceCriteria || [];

  return `# ${task.title} — 작업 결과

> Team Loop 리뷰 자료 · 생성 ${generated}

## 결과 요약

- ${taskResultSummary(task)}
- 상태: ${task.status || '미지정'}
- 담당자: ${personName(users, task.assigneeUserId)}
- 리뷰어: ${personName(users, task.reviewerUserId)}
- 실행자: ${executor ? `${executor.tool || '미지정'}${executor.model ? ` / ${executor.model}` : ''}` : '기록 없음'}

## 작업 목표

${task.description || '설명 없음'}

## 변경 파일

${changedPaths.length ? changedPaths.map((path) => `- \`${path}\``).join('\n') : '- 기록된 변경 파일 없음'}

## 검증 근거

${checks.length ? checks.map((check) => `- [${check.passed ? 'x' : ' '}] \`${commandText(check)}\` — 종료 코드 ${check.actualExit ?? '없음'} (기대 ${check.expectedExit ?? 0})`).join('\n') : '- 실행된 검증 없음'}

## 완료 조건 리뷰

${criteria.length ? criteria.map((criterion) => `- [ ] ${criterion}`).join('\n') : '- 등록된 완료 조건 없음'}

## 범위 및 실패 기록

- 범위 위반: ${verification?.scopeViolations?.length ? verification.scopeViolations.join(', ') : '없음'}
- 실패 사례: ${verification?.failureCaseIds?.length ? verification.failureCaseIds.join(', ') : '없음'}
- 검증 프로필: ${verification?.profile || task.verificationProfile || '미지정'}

## 리뷰 기록

- 판정: ${task.review?.status || '대기 중'}
- 의견: ${task.review?.comment || '없음'}
`;
}
