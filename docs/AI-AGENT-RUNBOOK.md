# Team Loop — AI Agent Connect & Work Runbook

**You are an AI coding agent (Claude, Codex, or similar). Read this before doing any
work in this repository.** Team Loop is a shared, AI-first work board. You do **not**
edit files freely. You work **through the board** so that three safety layers apply
automatically: a claim-time **scope lock**, a per-task **git worktree** (physical
isolation), and a **verify-in-worktree** gate. Approved work auto-merges into the main
branch with your attribution recorded.

---

## TL;DR — the loop you must follow

```
read context/skills  ->  create a SCOPED task  ->  claim it (scope lock)
->  create its worktree (isolation)  ->  edit ONLY inside the worktree, ONLY allowed paths
->  verify (program decides pass/fail, inside your worktree)
->  request review  ->  a separate reviewer approves  ->  auto-merge to main
```

Never `git commit`/`git push` your changes directly. Never touch files outside your
task's `allowedPaths`. The program lands approved work for you.

---

## 1. Connect

- **Server URL** (over Tailscale — you must be on the same tailnet):
  - `http://desktop-4flj7lg.tail20618c.ts.net:4173`  (stable MagicDNS name)
  - `http://100.105.168.17:4173`  (raw Tailscale IP fallback)
- **Prerequisites**: Node.js 20+. External MCP agents do not need either repository cloned locally. Log in once through the GitHub-hosted package:
  ```bash
  npx --yes --package=github:zheng0000000000000-art/NHN-Project team-loop \
    --server http://desktop-4flj7lg.tail20618c.ts.net:4173 login --name <you>
  ```
- **Log in** (the server owner gives you the signup code if one is set):
  ```bash
  export TEAM_LOOP_URL=http://desktop-4flj7lg.tail20618c.ts.net:4173
  team-loop register --name <you> --signup-code <CODE>   # first time
  team-loop login --name <you>
  ```
- **Set your executor profile** so your work is attributed:
  ```bash
  team-loop config set --tool claude-code --model <your-model>   # or: --tool codex
  ```

## 2. Use the MCP server (preferred for agents)

This repo ships a zero-dependency MCP server. Add it to your MCP client config:

```json
{
  "mcpServers": {
    "team-loop": {
      "command": "npx",
      "args": ["--yes", "--package=github:zheng0000000000000-art/NHN-Project", "team-loop-mcp"],
      "env": { "TEAM_LOOP_URL": "http://desktop-4flj7lg.tail20618c.ts.net:4173" }
    }
  }
}
```

Auth reuses your `team-loop login` session (or set `TEAM_LOOP_SESSION_COOKIE`).

**Tools available:** `list_tasks`, `show_task`, `create_task`, `claim_task`,
`read_task_files`, `submit_task_result`, `verify_task`, `request_review_task`,
`list_skills`, `list_harnesses`, `get_project_context`, `set_project_context`.

External agents never receive a server filesystem path. `read_task_files` returns scoped UTF-8 content plus a base commit. `submit_task_result` sends changed files back to the server, which applies them inside its own isolated worktree.

Keep discovery cheap: `list_tasks()` returns only task id, title, and status. Use
`list_tasks({ detail: "work" })` when comparing scopes or ownership, then `show_task`
only for the single task you intend to execute. Do not load every full task up front.

## 3. The workflow, step by step

1. **`get_project_context`** and **`list_skills`** — read the shared goals and the
   mandatory team rules (skills are lessons learned from past failures; follow them).
2. **`create_task`** with `allowedPaths` = the **only** files you may change, as globs
   (e.g. `["src/cli/**"]` or `["public/app.js"]`). Add clear `acceptanceCriteria` and
   assign a human owner.
3. The human owner chooses **에이전트 대기** on the board. Agents discover only work
   deliberately placed in this queue with `list_tasks({ agentQueue: true, mine: true })`.
4. **`claim_task`** — starts a queued task. If it fails with a **scope lock** error, an active
   task overlaps your paths; choose a non-overlapping scope or wait.
5. **`read_task_files`** — request only the scoped source files needed for the task and retain the returned `baseCommit`.
6. Produce changed UTF-8 files locally, then call **`submit_task_result`** with a work summary and learning disposition. The server rejects traversal, binaries, stale bases, oversized submissions, and paths outside `allowedPaths`.
7. **`verify_task`** — the server runs the harness **inside its worktree** plus a scope
   check. **You do not decide completion — the program does.** If it fails (harness or
   `SCOPE_VIOLATION`), fix inside the worktree and verify again.
8. **Close the learning loop before review.** List failures encountered during diagnosis,
   implementation, integration, and live verification, including failures fixed before the
   final passing run. For each failure, record exactly one disposition: reuse/link an existing
   skill or harness, create a narrowly reusable artifact, or document why it is one-off. A final
   PASS does not erase the failed path that produced the lesson.
9. **`request_review_task`** — moves it to REVIEW. A **separate** reviewer (a human, or
   the reviewer bot) approves. On approval your branch **auto-merges** into the main
   branch, and the commits carry trailers:
   ```
   Team-Loop-Task: tsk_...
   Executor: claude-code/<model>
   Reviewed-By: <reviewer>
   ```

The board intentionally shows only `에이전트 대기` or `에이전트 실행 중`; it does not
replace the human owner with a tool or model name. Detailed executor attribution is
kept in the verification result and final commit metadata, where it is useful for
auditing without turning the board into an agent-monitoring screen.

## 4. Hard rules

- **Stay in scope.** Only edit files inside your task's `allowedPaths`. Verification
  rejects out-of-scope changes as `SCOPE_VIOLATION`.
- **Do not self-approve** (unless the server explicitly runs in SOLO_MODE). A separate
  reviewer must approve — that is the point.
- **Do not land work yourself.** Approval triggers the merge; don't `git push`.
- **Learn from the corpus.** Failed verifications become shared skills; obey the rules
  from `list_skills`, especially: *do not modify paths owned by another agent's task.*
- **Report the learning disposition.** A task handoff must say which failures were recorded,
  which existing artifacts were reused, which new artifacts were created, or that no reusable
  failure was found. Silent omission is not an acceptable disposition.

## 5. Why this is safe (three layers)

- **Pre — scope lock:** two tasks with overlapping paths can't be active at once.
- **Physical — worktree:** each submitted task is applied to its own server-side git checkout; the external agent never writes the official tree directly.
- **Post — verify-in-worktree:** the harness + scope check run in the server worktree, so your
  isolated changes are actually checked before anyone approves them.

If you follow this loop, multiple agents (and humans) can build in parallel without
stepping on each other, and every change is verified, reviewed, and attributed.
