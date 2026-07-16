# Member Usage Guide for AI Agents

This document is written for an AI agent that needs to explain or perform the workflow for a non-admin member using a running Team Loop Lite server.

## Server Identity

- Product: Team Loop Lite + AI
- Default local URL: `http://127.0.0.1:4173`
- Shared team URL: use the host or LAN/VPN URL supplied by the admin, for example `http://TEAM_HOST:4173`
- Workspace authority: the server `WORKSPACE_ROOT`; members should treat this as the repository being coordinated.
- Authentication model: cookie session through browser or CLI.
- Roles:
  - `admin`: first registered user, or server-managed admin user.
  - `member`: every later normal user.

## Member Registration

Use this when a new user needs to join as a member.

1. Open the server URL in a browser.
2. Choose `사용자 등록`.
3. Enter:
   - `name`: display/login name, 2-40 characters.
   - `password`: at least 8 characters.
   - `signupCode`: required only if the server was started with `SIGNUP_CODE`.
4. Submit.
5. If registration succeeds, the server logs the user in immediately.

CLI equivalent:

```bash
team-loop --server http://TEAM_HOST:4173 register --name Alice --signup-code CODE
team-loop --server http://TEAM_HOST:4173 login --name Alice
```

Environment shortcut:

```bash
export TEAM_LOOP_URL=http://TEAM_HOST:4173
team-loop login --name Alice
```

On Windows PowerShell:

```powershell
$env:TEAM_LOOP_URL = "http://TEAM_HOST:4173"
team-loop login --name Alice
```

## Member Login

Browser:

1. Open the server URL.
2. Choose `로그인`.
3. Enter name and password.

CLI:

```bash
team-loop --server http://TEAM_HOST:4173 login --name Alice
team-loop whoami
team-loop dashboard
```

The CLI stores a session per server under the Team Loop CLI home. For automation, use `TEAM_LOOP_SESSION_COOKIE` instead of saving a long-lived interactive session.

## Member Capabilities

A member may:

- View the board, WIKI, discussion, harnesses, skills, failures, and visible usage dashboard.
- Create tasks.
- Claim ready tasks.
- Work on tasks assigned to them or tasks where they are a participant.
- Run verification for their own in-progress task.
- Request review after verification.
- Approve or reject tasks where they are the reviewer.
- Use AI helper endpoints for draft tasks, next tasks, task briefs, and verification summaries.
- Add project context.
- Write in `대화`.
- Press `회의록 저장` to turn recent chat into WIKI meeting notes.
- View WIKI context, project history, meeting notes, and archived cases.
- Apply active harnesses/skills only to tasks where they are creator, assignee, or reviewer.
- Push their own external CLI usage snapshots.

A member may not:

- Create, update, test, activate, or disable harnesses.
- Activate or disable skills.
- Craft new learning artifacts from cases.
- Use AI auto-craft for harness/skill creation.
- Promote failure cases to fixture candidates.
- Perform admin-only user or registry maintenance.
- Review their own task unless the server is explicitly running with `SOLO_MODE=true`.

## Normal Browser Workflow

Use this sequence for a human member working through the web UI.

1. Login.
2. Open `작업 보드`.
3. Read existing tasks and choose one of:
   - Create a new task with narrow allowed paths and clear acceptance criteria.
   - Claim an existing `READY` task.
4. If needed, open `AI 도우미`:
   - Save project context.
   - Ask for a task draft.
   - Ask for a brief for a selected task.
5. Work in the repository within the task `allowedPaths`.
6. Run task verification from the UI.
7. If verification passes, request review.
8. Reviewer checks scope, acceptance criteria, verification, and comments.
9. Reviewer approves to move task to `DONE`, or rejects with a comment.
10. Use `대화` for lightweight team discussion.
11. Use `회의록 저장` when a chat should become persistent WIKI meeting notes.

## Normal CLI Workflow

Use this sequence when a member operates through CLI.

```bash
team-loop --server http://TEAM_HOST:4173 login --name Alice
team-loop whoami
team-loop tasks
team-loop task show <task-id>
team-loop task claim <task-id>
```

After editing files inside the task scope:

```bash
team-loop task verify <task-id>
team-loop task request-review <task-id>
```

Reviewer flow:

```bash
team-loop tasks --status REVIEW
team-loop task show <task-id>
team-loop task approve <task-id> --comment "Looks good."
```

Reject when verification is stale, failing, out of scope, or acceptance criteria are not met:

```bash
team-loop task reject <task-id> --comment "Verification failed or scope needs correction."
```

## Creating A Task As A Member

Required shape:

- `title`: short result-oriented name.
- `description`: what to change and why.
- `acceptanceCriteria`: one criterion per line; must be objectively checkable.
- `allowedPaths`: narrow path patterns. Use `**` only for truly repo-wide tasks.
- `verificationProfile`: choose an existing profile.
- `assigneeUserId`: optional.
- `reviewerUserId`: optional but recommended.

CLI:

```bash
team-loop task create \
  --title "Fix inventory tooltip overflow" \
  --description "Prevent long item names from overflowing the tooltip panel." \
  --allowed-path "src/ui/inventory/**" \
  --criterion "Long item names wrap inside the tooltip." \
  --criterion "Existing inventory tests pass." \
  --profile repository-basic \
  --assignee Alice \
  --reviewer Bob
```

## Task State Rules

Expected task flow:

```text
READY -> IN_PROGRESS -> REVIEW -> DONE
                    \-> BLOCKED
REVIEW -> IN_PROGRESS when rejected
```

Important rules:

- Mutations require the current task `version`; stale updates fail with `409`.
- Running verification records evidence and can create failure cases.
- Requesting review should only happen after meaningful verification.
- Approval is a human decision; AI summaries are advisory only.
- If assignee and reviewer are the same user, review is blocked unless `SOLO_MODE=true`.

## Discussion And Meeting Notes

The `대화` tab is a lightweight chat surface.

- Members type messages into the chat.
- Messages are stored in `data/discussions.json`.
- Pressing `회의록 저장` asks AI to summarize recent messages.
- The saved AI summary appears in `WIKI > 회의록`.
- If AI is unavailable, the server stores a fallback note based on recent message text.

AI behavior expectation:

- Treat chat as informal source material.
- Treat WIKI meeting notes as persistent project memory.
- Do not treat a chat message as a final decision unless the meeting note or task state confirms it.

## WIKI Usage

The `WIKI` tab is the persistent memory surface.

Current sections:

- `프로젝트 컨텍스트`: stable project rules and background used by AI helper calls.
- `최근 흐름`: task timeline and milestone history.
- `회의록`: AI-saved summaries from team chat.
- `아카이브 항목`: resolved or ignored failure/case archive.

AI agents should prefer WIKI content over raw chat when reconstructing project history.

## Usage Dashboard For Members

Members can see usage information scoped to themselves unless they are admin.

- `사용량 대시보드` shows server AI usage and external CLI usage when available.
- External usage is not automatically known by the server; members should run usage push from their own environment.

CLI:

```bash
team-loop usage status --days 30
team-loop usage push
```

Daemon option:

```bash
team-loop usage push --daemon --interval 300
```

Privacy expectation:

- Usage collectors send token counts, model names, tools, and quota windows.
- They should not send prompt or response bodies.

## AI Helper Boundaries

The AI helper can:

- Draft tasks.
- Suggest next tasks.
- Create task briefs.
- Summarize verification evidence.
- Save chat summaries as WIKI meeting notes.

The AI helper must not:

- Claim a task is complete.
- Override program verification.
- Approve review by itself.
- Ignore `allowedPaths`.
- Invent repository facts not present in task data, WIKI, or verification evidence.

## Common Failure Handling

If registration fails:

- `403 Invalid signup code`: ask admin for the correct `SIGNUP_CODE`.
- `403 First administrator registration window expired`: admin must restart with `SIGNUP_CODE`.
- `409 That name is already registered`: choose another name or login.

If task mutation fails:

- `401`: login again.
- `403`: current user is not the assignee, reviewer, creator, participant, or admin required for that action.
- `409`: reload task; version is stale or task is in the wrong state.

If review fails:

- Check whether assignee and reviewer are the same user.
- Check whether `SOLO_MODE=true` is intentionally enabled.
- Check whether verification is passing and current.

If AI save fails:

- Verify AI provider status in bootstrap or UI.
- If the server fallback is enabled, a fallback meeting note may still be created.

## Minimal AI Checklist Before Guiding A Member

1. Confirm `SERVER_URL`.
2. Confirm whether the user already has an account.
3. If registering, ask whether a `SIGNUP_CODE` is required.
4. Confirm the user is a normal `member`, not admin.
5. Direct them to login.
6. For work, prefer existing `READY` tasks before creating new tasks.
7. Before editing, inspect task `allowedPaths`.
8. After editing, run verification.
9. Send to review; do not self-approve unless `SOLO_MODE=true`.
10. For discussion, use `대화`; for durable memory, use `회의록 저장` and read it from `WIKI > 회의록`.
