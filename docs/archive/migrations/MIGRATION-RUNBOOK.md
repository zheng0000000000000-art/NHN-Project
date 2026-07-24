# Local-First Dashboard migration runbook

Team Loop is the canonical product. The former Local-First Workflow Dashboard is
an evidence source, not a second runtime.

## Import boundary

1. Run `node tools/migration/import-local-first.mjs <legacy-root> <candidate.json>`.
2. Review the candidate bundle. Nothing is activated automatically.
3. Promote deterministic checks into harnesses, reusable judgment into skills,
   and explanatory material into the wiki.
4. Keep task-board data portable. Personal wiki, context packs, experience,
   skill state, and harness state stay local.
5. Archive legacy runtime histories before removing generated artifacts.

The importer is read-only with respect to the legacy repository. It intentionally
does not import users, tokens, process state, run logs, build outputs, or outbox
transport state.
