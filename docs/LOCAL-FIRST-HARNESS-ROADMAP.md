# Harness Roadmap

Adapted from the local-first dashboard harness catalog. These are not copied
C# commands; they are Node-oriented candidates for this repository.

## Current Baseline

- `repository-basic`
  - active
  - runs `git diff --check`
- `node-project`
  - disabled
  - runs `node --test` and `git diff --check`

## Recommended Profiles

### `post-executor`

Use after a CLI or external executor has modified files.

Checks:

- `node --test`
- `git diff --check`
- scope check against the task `allowedPaths`
- no merge conflict markers
- optional browser smoke test when public UI changed

Expected state: worktree may be dirty, but only inside the task scope.

### `post-commit`

Use after a human or admin commits.

Checks:

- worktree clean
- `node --test`
- `git diff --check HEAD~1 HEAD`
- no ignored runtime data accidentally staged

Expected state: worktree clean except user-owned unrelated edits.

### `ui-smoke`

Use when `public/**` changes.

Checks:

- server responds to changed page
- page renders without JavaScript errors
- one primary click path works
- mobile-width layout has no obvious overflow

## Harness Candidates

### `scope-check`

Purpose: fail if a task changes paths outside `allowedPaths`.

Why: the old dashboard had repeated worktree contamination failures. Team Loop
already binds verification to git scope; this should become visible as a named
harness.

Expected input:

- task id
- allowed path globs
- changed files from git

Expected verdict:

- exit 0 if every changed file is allowed
- exit 1 if any changed file escapes scope

### `path-guard-check`

Purpose: prove path containment treats directory boundaries correctly.

Cases:

- root itself
- valid child
- sibling prefix, such as `data-escape` vs `data`
- parent traversal to sibling
- encoded backslash or encoded dot/backslash in route-like inputs

Expected verdict:

- exit 0 when all known escape cases are rejected

### `gate-clean`

Purpose: normalize git clean/dirty detection instead of relying on raw output
format.

Expected verdict:

- exit 0 when no tracked changes exist
- exit 1 when tracked changes exist
- exit 2 on git errors

### `e2e-usage`

Purpose: exercise the real workflow through the CLI.

Scenario:

1. create a temporary task
2. claim it
3. run verification
4. observe review state
5. clean temporary artifacts

Expected verdict:

- exit 0 if the task lifecycle behaves as expected
- exit 1 if task state transitions differ

### `hs-scan`

Purpose: find repeated failures that deserve promotion.

Inputs:

- `failure-cases.json`
- existing harness and skill registries

Output:

- candidate id
- repetition count
- suggested artifact type: harness, skill, or document
- score dimensions from `LOCAL-FIRST-KNOWLEDGE-PROMOTION.md`

Expected verdict:

- exit 0 when no candidates exist
- exit 1 when candidates exist
- exit 2 on invalid corpus

Exit 1 is a signal, not a failure.
