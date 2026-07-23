# Team Loop engine boundary

Team Loop is an agent experience engine. MCP is its primary agent interface;
the private console is its operator interface, and the portable workboard is a
deliberately small external surface.

## Primary experience loop

1. `experience_prepare` assembles durable wiki knowledge, relevant workspace
   sources, previous failures, applicable skills and a verification harness.
2. The agent performs the work and verifies the result.
3. `experience_reflect` records what happened, what was used and what was
   discovered.
4. Discoveries become wiki candidates. Failures become skill or harness
   candidates. Candidates remain reviewable instead of silently changing future
   agent behavior.

The first MCP tools for this contract are:

- `experience_prepare`
- `experience_reflect`
- `wiki_search`
- `wiki_propose`

Legacy task transport tools remain available during migration, but new agent
workflows should start with `experience_prepare` and end with
`experience_reflect`.

## Product boundary

- Private: prompts, model and executor choices, verification details, learning
  records, failure history, write scopes, internal discussion and audit data.
- Shareable: task title, state, priority, display assignee, schedule and artifact
  metadata.
- Portable: the workboard can be rendered as one HTML file containing its data,
  CSS and JavaScript. It does not require Team Loop, authentication or a network
  connection after export.

## Code boundary

- `src/engine/workboard-engine.js` is a pure data projection. It must not import
  HTTP, authentication, persistence or browser code.
- `src/engine/standalone-workboard.js` turns the public projection into a portable
  HTML artifact.
- `server.js` is an adapter. It authenticates the owner, supplies stored data and
  returns the rendered artifact.
- The existing dashboard remains the private operator console.
- `src/experience-engine.js` composes the context and learning subsystems into
  the primary agent workflow.
- `src/wiki-store.js` stores durable knowledge as reviewable candidates and
  active entries.
- `src/experience-journal.js` keeps append-only execution reflections.

New integrations belong in adapters around the engine. They must not add
provider-specific state or credentials to the engine contract.

## Export

From a signed-in CLI session:

```powershell
team-loop board export --output workboard.html
```

The resulting file may be opened directly or placed on any static web server.

## Balance engine

`src/engine/balance-engine.js` is a provider-neutral deterministic search
engine. Providers supply a pure simulation function; `combat-v1` is the first
adapter migrated from the Local-First Dashboard.

- Input: a `BalanceSpec` and immutable baseline.
- Output: candidate data, score, solution status, and an `ObservationSet`.
- Candidates are never written or applied by the engine.
- HTTP and MCP expose the same operation through `POST /api/balance/run` and
  `balance_run`.

`examples/balance/ruined-lab.json` is the converted legacy fixture.
