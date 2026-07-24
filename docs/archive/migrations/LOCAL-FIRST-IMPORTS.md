# Local-First Imports

Imported and adapted from:

`C:\Users\1\Documents\Local-First Workflow Dashboard`

This project should not copy the old C# implementation wholesale. The reusable
parts are the operating rules, failure taxonomy, and harness contracts. The
runtime implementation here remains Node.js.

## Imported Documents

- `docs/LOCAL-FIRST-KNOWLEDGE-PROMOTION.md`
  - How repeated failures become harnesses, skills, or documentation.
- `docs/LOCAL-FIRST-HARNESS-ROADMAP.md`
  - Node-oriented harness candidates adapted from the old dashboard.
- `docs/LOCAL-FIRST-DECISIONS.md`
  - Short versions of the decisions that matter for this project.
- `docs/LOCAL-FIRST-FAILURE-SEEDS.json`
  - Machine-readable failure examples for future seeding or migration.

## Already Imported Into Runtime Data

The following skills were imported into local `data/skills.json` as active
runtime skills:

- `powershell-encoding`
- `execution-verification`
- `root-cause-diagnosis`
- `path-escape-qa`

`data/skills.json` is ignored by git, so this document is the committed record
of why those runtime skills exist.

## Do Not Import

- `.git`, `.vs`, `server/bin`, `server/obj`
- `outputs/archive`, executor logs, launch scratch files
- the C# server as source code
- stale outbox artifacts

Bring over behavior as Node harnesses only after there is a clear local use.
