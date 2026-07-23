# Dashboard to Team Loop contract alignment

Team Loop is the canonical runtime. Local-First Workflow Dashboard remains the
source of proven operational knowledge while its contracts are imported.

## Shared contract version

All shared contracts use `schemaVersion: 1`. Runtime normalization lives in
`src/contracts.js`; the machine-readable catalog lives in
`config/experience-contracts.json`. Agents can inspect the same catalog through
the MCP tool `experience_contracts`.

## Field mapping

| Dashboard | Team Loop canonical | Compatibility |
| --- | --- | --- |
| Context Pack `diId` | `packId` | accepted as an input alias |
| directive `allowlist` | `writeScope` | accepted as an input alias |
| `requiredInputs[].sha256` | same | full-file SHA-256 |
| `readOrder` | same | required inputs must be present |
| `forbiddenActions` | same | preserved |
| Skill manifest five fields | `skill.manifest` | preserved without renaming |
| gate check `command` | `harnessId` | accepted as an input alias |
| harness command `file` | contract check `command` | adapted without changing runtime execution |
| `expectedExit` | same | non-zero expected success remains valid |
| `mutatesState` | same | retained as verification truth |

## Invariants

- A required input is immutable for that run and may not overlap `writeScope`.
- `requiredInputs.sha256` hashes the complete file bytes, not a selected chunk.
- Procedural and assisted skills declare at least one human approval point.
- Every harness and gate check has a unique deterministic order.
- Knowledge needs at least two occurrences before promotion consideration.
- Promotion priority is harness, then skill, then wiki.
- Promotion is never automatic; agents create candidates and an operator
  promotes them.

## Implemented migration order

1. Dashboard skill Markdown and failure cases are exported as review-only
   candidates by `tools/migration/import-local-first.mjs`.
2. Shared seeded skills carry manifests and remain operator-controlled.
3. `context-pack-integrity` validates the shared JSON contract and full-file
   hashes with stable exit codes.
4. Gate commands map to registered Team Loop harness IDs.
5. Knowledge-promotion scoring requires repeated evidence and never activates
   artifacts automatically.

Historical logs, prompts, outbox files, and archived execution artifacts are not
part of the contract migration.
