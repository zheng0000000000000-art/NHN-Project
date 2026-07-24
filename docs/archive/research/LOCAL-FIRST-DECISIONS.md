# Local-First Decisions Adapted For Team Loop

These are short local decisions imported from the old workflow dashboard. They
are not full ADRs, but they explain why this project behaves the way it does.

## Separate Maker And Reviewer

Imported from `ADR-002`.

The person or agent that creates a harness, skill, or task output should not be
the only authority that approves it.

Team Loop implication:

- program verification can move a task to review
- final approval should come from another user or an explicit solo-mode policy
- self-approval should be a conscious mode, not an accidental default

Reason:

The maker tends to encode the same mistaken assumption into both the change and
the check.

## Transport Receipt Before Executor Trust

Imported from `ADR-010`.

When an external CLI executor is launched, do not treat its output as evidence
that it received the intended instruction. Prove the transport boundary first.

Preferred evidence:

- exact prompt/input bytes sent
- hash of bytes received by the CLI when the CLI supports replay or echo
- wrapper pid and real executor pid when a shell wrapper is used
- quota/auth/process-liveness signals separated from model behavior

Team Loop implication:

- future Claude/Codex auto-executor support should record transport evidence
- ACK text from the model is useful but insufficient
- command-line prompt delivery should be avoided for long or Korean text

## Metrics Are Not The Purpose

Imported from `ADR-005`.

A green metric can still miss the user goal. Verification reports should state
both:

- what executable checks passed
- what user-visible purpose remains unproven

Team Loop implication:

- `task verify` pass should not be worded as product completion by itself
- review remains useful even when the harness is green

## Event-Driven Beats Timer-Driven

Imported from `ADR-009`.

Poll less when resources are scarce. Prefer event triggers:

- task created
- task verified
- review requested
- failure recorded
- quota refreshed

Team Loop implication:

- future background workers should wake on state changes when possible
- periodic scans should be reserved for reconciliation and recovery
