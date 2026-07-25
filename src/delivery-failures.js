const PATH_LINE = /^\s*([A-Za-z0-9_.@/\\-]+\.[A-Za-z0-9]+)\s*$/;

export function classifyDeliveryFailure(error, { phase = 'merge' } = {}) {
  const message = String(error?.message || error || 'Unknown delivery failure').trim();
  const paths = extractConflictPaths(message);
  let kind = 'DELIVERY_ERROR';
  let title = 'Task delivery failed';

  if (/worktree is missing|worktree was missing/i.test(message)) {
    kind = 'WORKTREE_MISSING';
    title = 'Task delivery worktree was missing';
  } else if (/index\.lock|could not write index|stash failed/i.test(message)) {
    kind = 'STALE_GIT_LOCK';
    title = 'Git index lock blocked task delivery';
  } else if (/would be overwritten by merge|merge conflict|conflict \(content\)|automatic merge failed/i.test(message)) {
    kind = 'DELIVERY_CONFLICT';
    title = paths.length ? `Task delivery conflicted on ${paths.length} path(s)` : 'Task delivery encountered a merge conflict';
  } else if (/ENOENT|not recognized as an internal or external command|cannot find the file/i.test(message)) {
    kind = /worktree|working directory|cwd/i.test(message) ? 'WORKTREE_MISSING' : 'GIT_EXECUTION_ERROR';
    title = kind === 'WORKTREE_MISSING' ? 'Task delivery worktree was missing' : 'Git could not run during task delivery';
  } else if (/not a working tree|cannot change to|no such file or directory/i.test(message)) {
    kind = 'WORKTREE_MISSING';
    title = 'Task delivery worktree was missing';
  }

  return {
    harnessId: 'delivery-integrity',
    kind,
    title,
    identity: {
      operation: 'task-delivery',
      phase: String(phase),
      kind,
      paths,
    },
    evidence: {
      phase: String(phase),
      paths,
      error: message.slice(0, 8_000),
    },
  };
}

function extractConflictPaths(message) {
  const paths = [];
  let collecting = false;
  for (const line of String(message).split(/\r?\n/)) {
    if (/following (?:untracked working tree )?files would be overwritten by merge/i.test(line)) {
      collecting = true;
      continue;
    }
    if (collecting && /^(?:Please |Aborting|Merge with strategy|error:)/i.test(line.trim())) {
      collecting = false;
    }
    if (!collecting) continue;
    const candidate = line.trim().replace(/^[-*]\s*/, '').replaceAll('\\', '/');
    if (PATH_LINE.test(candidate)) paths.push(candidate);
  }
  return [...new Set(paths)].sort();
}
