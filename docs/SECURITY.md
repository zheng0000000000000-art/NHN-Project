# Team Loop — Security Model & Hardening Roadmap

This server runs harness commands, git operations, and (via dispatch) AI executors on
the **host machine**. Treat it as a code-execution service, not a passive web app. It
was designed for LAN/VPN use; do not expose it to the public internet without the P0/P1
items below.

## Threat model — who can do what

| Actor | Reaches | Can do | Risk |
|---|---|---|---|
| Anonymous (network) | HTTP endpoints | register (needs `SIGNUP_CODE`), login (rate-limited) | brute force, scanning |
| Member (logged in) | board API + MCP | create/claim/verify/review tasks, read/write project context, worktrees | **verify runs harness commands from a member-editable worktree on the host** |
| Admin | + harness/skill authoring & activation | define harness commands (= arbitrary shell) | full RCE by design (keep admins minimal) |
| Local operator (CLI) | `dispatch --execute` | spawn claude/codex with permissions bypassed | arbitrary command execution locally |

## Top risks (prioritized)

1. **P0 — Verify executes code on the host.** `repository-basic` (`git diff --check`) is
   safe, but `node-project` runs `node --test`, which **executes test files from the
   worktree**. A member scoped to `test/**` can add a malicious test and trigger
   verification → **remote code execution on the host**. Worktrees isolate *file writes*,
   not *command execution*.
2. **P0 — dispatch executor bypasses permissions.** `dispatch --execute` runs the agent
   with `bypassPermissions` / `--sandbox`, so it can run any command. Currently only
   reachable via the local CLI (not HTTP/MCP), so the risk is "you dispatching a malicious
   task," not remote — but it should default to a safe mode.
3. **P1 — Auth is thin.** `SIGNUP_CODE` is a single static shared string; no 2FA, no
   account lockout beyond rate limiting. Sessions are single-process with a local secret;
   `SECURE_COOKIES` is off (correct for Tailscale HTTP, required if served over HTTPS).
4. **P1 — Public exposure.** A tunnel puts all of the above on the internet. Keep it on
   Tailscale (invited devices only).
5. **P2 — Secrets at rest.** `data/app-secret.key` (session signing) and any saved bot
   password live on disk in the clear; protect the data dir and the machine.

## Already in place (do not regress)

- `SIGNUP_CODE` enforced; **SOLO_MODE off** (separate review required); exactly one admin.
- Claim-time **scope lock** (no two overlapping-scope tasks active at once).
- Per-task **git worktree** isolation (file writes cannot touch other tasks/the main tree).
- **Verify-in-worktree** scope gate (out-of-scope changes fail as `SCOPE_VIOLATION`).
- Harness/skill authoring & activation are **admin-only**.
- Login/register **rate limiting** (10/min per IP+name); `X-Team-Loop-Client` header required.
- Network: **Tailscale-only**, Windows firewall scoped to the Tailscale CGNAT range; server
  run in **stable (non-watch)** mode so code edits don't drop connections.

## Hardening roadmap

### P0 — do before trusting non-owner members with the board
- **Restrict member verification profiles.** Non-admins may only use profiles that do not
  execute repo code (e.g. `repository-basic`). Code-executing profiles (`node --test`)
  require admin assignment. (Small server change: gate `verificationProfile` by role.)
- **Sandbox harness + executor execution.** Run every harness command and every dispatch
  executor inside a real sandbox: a container or a low-privilege restricted user, with
  **no network**, a temp/RO filesystem view, CPU/memory limits, and hard timeouts
  (timeouts already exist). This is the only thing that truly contains RCE. It is a
  platform-specific effort (Docker, or Windows restricted token / job object) and should
  be designed as its own task — a half-built sandbox is worse than none.
- **Default dispatch to a safe permission mode** (no `bypassPermissions` unless an explicit
  `--trust` flag is passed by the operator).

### P1 — do before any public/HTTPS exposure
- Terminate TLS (tunnel or reverse proxy) and set `SECURE_COOKIES=true`.
- Replace the static `SIGNUP_CODE` with per-invite tokens; add account lockout.
- Consider per-agent API tokens (scoped) instead of full sessions for MCP bots.

### P2 — defense in depth
- Log and alert on external IPs / unusual registration; optional 2FA for admins.
- Encrypt or vault secrets at rest; rotate `app-secret.key` on suspected compromise
  (delete it and restart to invalidate all sessions).

## Deployment policy

- Keep access on **Tailscale**, invite only trusted people/devices, keep **admins minimal**.
- Run **one canonical, stable server** (`node server.js`, not `--watch`); agree on who owns
  it so it isn't restarted into a weaker config.
- Land code only through the board loop (claim → worktree → verify → review → auto-merge),
  which records attribution and keeps the main branch clean.
