# Global data alignment

The Dashboard and Team Loop both use `schemaVersion`, but their global data is
not one schema. Schema versions are scoped to each document `kind`; version 1 of
a Team Loop wiki is unrelated to version 1 or 2 of a Dashboard workflow.

Team Loop remains the canonical runtime. Dashboard data is mapped by meaning,
not copied into Team Loop stores by filename.

## Data mapping

| Dashboard data | Team Loop destination | Decision |
| --- | --- | --- |
| `projects.json` | workspace manifest and `.team-loop/project.json` | map project identity and paths |
| `workflow-definition.json` | future `LoopDefinition` | preserve stages, gates, guardrails and provider references |
| `workflow-state.json` | future `LoopState` plus append-only events | do not merge into tasks |
| `blueprint.json` | future `BalanceSpec` | preserve metric target/band, priority and note |
| `measurement.json` | future `ObservationSet` | preserve provider, timestamp, metric values and evidence |
| `patch-proposal.json` | task/run candidate or experience evidence | migrate only active or historically useful proposals |
| `review-report.json` | review evidence | summarize; do not import the 778 KB historical file as live state |
| `run-log.json` | run ledger events | convert selected events to JSONL; do not copy the 583 KB monolith |
| `contributions.json` | wiki/skill candidates | migrate candidates through promotion review |
| `WORKSTATE.json` | none | old orchestration state; retain in the archive repository |
| `WP-REGISTRY.json` | none | old handoff tracking; retain in the archive repository |

## Canonical global contracts still missing

The experience contracts are aligned. These runtime contracts still need to be
implemented before simulation or measurement data is imported:

1. `LoopDefinition`
   - stages, gate conditions, guardrails, checkpoints and measurement provider
2. `LoopState`
   - current stage, loop state, iteration, blocks and suspended tracks
3. `BalanceSpec`
   - metric id, target or band, priority and explanation
4. `ObservationSet`
   - provider identity, measured time, values and direct evidence
5. `ExperienceEvent`
   - append-only event envelope shared by measurement, verification and reflection

## Invariants

- Every global document declares both `kind` and `schemaVersion`.
- Version migration is per `kind`; there is no global schema version.
- Definitions, current state, observations and decisions stay in separate files.
- Measurements never contain approval verdicts.
- Proposals never become state without an explicit state-transition event.
- Historical logs are append-only events, not a mutable global JSON array.
- Direct evidence is retained; proxy-only evidence cannot become a harness.

## Skill consolidation

| Dashboard skill | Team Loop action |
| --- | --- |
| `verification` | merge unique rules into `execution-verification` |
| `root-cause-diagnosis` | import as a committed seed with the shared manifest |
| `powershell-encoding` | import as a committed seed with the shared manifest |
| `path-escape-qa` | import as a committed seed with the shared manifest |
| `directive-writing` + `directive-authoring` | merge into one instruction-contract skill |
| `hs-gate` | split into deterministic `hs-scan` harness and promotion-review skill |
| `executor-launch` | retain as a narrow transport-evidence candidate |
| `file-navigation` | archive unless evidence shows repeated value |
| `design` and docs `README` | keep domain-scoped; load only for matching work |
| `balance-tuning` | retain and adapt to the future `BalanceSpec` contract |

The Dashboard files currently declare version and trigger lines but none of the
12 inspected skills contains the documented five-field manifest. Import must
therefore generate candidate manifests and require review.

## Harness consolidation

| Dashboard harness | Team Loop action |
| --- | --- |
| `build-verify` | merge into `node-project`/`verified-run` |
| `scope-check` | expose the verifier's existing scope gate under this name |
| `context-pack-integrity` | port first against `team-loop-context-pack` |
| `gate-clean` | port as a reusable Git-state primitive |
| `e2e-usage` | keep as a separate real-workflow scenario |
| `hs-scan` | port after failure taxonomy migration |
| `path-guard-check` | keep as a high-value security regression candidate |
| `call-integrity-check` | keep as a candidate; activate only with direct fixtures |
| `project-api-edge-check` | merge into server security tests |
| `template-sync-check` | keep only if templates remain runtime inputs |
| `claim-check`, `handoff-integrity`, `launch-check`, `di-completion-check`, `state-transition-callsite-check` | archive as old orchestration-specific checks |

Implemented: `context-pack-integrity`, the consolidated durable skill seeds,
and the `LoopDefinition`, `LoopState`, `BalanceSpec`, `ObservationSet`, and
`ExperienceEvent` contracts. Dashboard simulation data can now be converted
through these contracts without importing mutable run state as product truth.
