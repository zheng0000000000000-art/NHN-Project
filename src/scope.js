// Scope overlap detection for the claim-time scope lock.
//
// Two tasks conflict when their allowedPaths could match a common file, so that
// starting one while an overlapping task is already active is refused. This is a
// conservative pre-check that complements (does not replace) the verifier's
// SCOPE_VIOLATION gate, which catches edits that stray outside a task's declared scope.

// Reduce a glob pattern to its literal directory/file prefix (everything before the
// first wildcard segment). 'src/cli/**' -> 'src/cli'; 'server.js' -> 'server.js';
// '**' -> '' (matches everything).
export function scopePrefix(pattern) {
  const segments = String(pattern ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .split('/');
  const literal = [];
  for (const segment of segments) {
    if (segment.includes('*')) break;
    literal.push(segment);
  }
  return literal.join('/');
}

// Does literal prefix `a` cover prefix `b` (a is equal to, or an ancestor of, b)?
export function prefixCovers(a, b) {
  if (a === '') return true; // '' came from '**' or similar: matches everything
  if (a === b) return true;
  return b.startsWith(`${a}/`);
}

// Do two allowedPaths lists overlap (could both match some common file)?
export function scopesOverlap(listA, listB) {
  const a = Array.isArray(listA) ? listA : [];
  const b = Array.isArray(listB) ? listB : [];
  for (const patternA of a) {
    for (const patternB of b) {
      const prefixA = scopePrefix(patternA);
      const prefixB = scopePrefix(patternB);
      if (prefixA === '' || prefixB === '' || prefixA === prefixB
        || prefixCovers(prefixA, prefixB) || prefixCovers(prefixB, prefixA)) {
        return true;
      }
    }
  }
  return false;
}
