# Game AI Technical Design: AI-Native Auction Opponents

Scope: the demo game `public/roguelite.html` (a 12-round sealed-bid auction, "Unknown
Auction"). This document covers judging criterion **T3 (technical documentation)**:
architecture, model and data flow, prompts as design components, validation, failure
modes, fallback, latency, cost, and privacy. It is written against the **actual code** so
the document, the code, and execution results stay consistent - every mechanism below
names the function or file it describes.

---

## 1. Current architecture (baseline / "AI-off")

Today the three opponents are **scripted heuristics with RNG**. There is no model call
anywhere in the game; the "AI" label is cosmetic. All logic lives in the single inline
`<script>` of `public/roguelite.html`.

**Opponents** (`BOT_TEMPLATES`): three fixed personalities.

| id | name | aggression | bluff | strategy hook |
|----|------|-----------|-------|---------------|
| `collector` | Collector | 1.08 | 0.08 | favors one random set; overpays for its favored tag |
| `trader` | Trader | 0.92 | 0.03 | pure value arbitrage (known value x1.05) |
| `rival` | Rival | 1.00 | 0.13 | denies the player's focus tag |

**Valuation** (`botPrivateValuation(bot, item)`):
`noisyKnownValue = item.value * rand(0.72, 1.28)` (each bot has noisy knowledge of the
true value) `+ itemSynergyValue(bot, item)` (set-completion weighting), then a
personality adjustment, then `* bot.aggression * scarcity`, where
`scarcity = money < 20 ? 0.74 : money < 35 ? 0.88 : 1`.

**Bid** (`botBid`): `round(clamp(valuation * rand(0.78, 1.05), 0, bot.money))`.

**Interest signal** (`interestSignal`): the only thing the player sees before committing
a blind bid. With probability `bot.bluff` the valuation is perturbed by `rand(-10, 10)`,
then thresholds map to four tiers: strong interest / interested / watching / cool.

**Resolution** (`resolveAuction`): sealed-bid; highest bid wins; ties break by remaining
money, then random. **Scoring** (`totalScore`): `rawValue + setBonus + floor(money*0.2)`.

Consequence for judging: runtime behavior is fully determined by `Math.random()` and
arithmetic. Turning the AI off changes nothing because there is no AI - so the game scores
poorly on T2 (AI-native gameplay). This baseline is still valuable: it becomes the
**fallback and the "AI-off" arm** of the required AI-on/AI-off comparison.

---

## 2. Existing AI infrastructure we can reuse

`src/ai.js` already ships a local-first structured-output client, `AIService`:

- Provider defaults to **ollama** when no API key is present; model
  `qwen2.5-coder:14b`; base URL `http://127.0.0.1:11434`; request timeout 60s.
- Structured output: `#ollamaStructured` (Ollama JSON mode) and, for hosted providers,
  `/responses` with `json_schema` `strict: true`.
- It is **advisory-only** by construction (`advisoryOnly: true`) with the guardrail
  instruction: "output is advisory; never claim the task is complete; never bypass human
  review or program verification."
- Token usage is already tracked by the platform's usage collector.

We also built `tools/experiments/ollama-executor.mjs`, which proves the same local model
reliably returns strict JSON (Ollama `format: json`) for a given work order. The auction
opponents can be driven by the identical pattern.

---

## 3. Target architecture (AI-native / "AI-on")

Design principle: **the model decides, the program bounds.** The local model proposes
each opponent's private valuation, interest tier, bid intent, and one line of banter; the
server validates and clamps the result; the heuristic remains as both the fallback and the
sanity bound. This keeps the game always-playable while making runtime AI output actually
change game state (who wins each item, and therefore the final score).

```
browser (public/roguelite.html)
    |  POST /api/roguelite/decide   { round, item(public), bots(public+own state) }
    v
server route (server.js)  --->  AIService (src/ai.js, provider=ollama)
    |                                   |  POST /api/chat  format:json  (one batched call)
    |                                   v
    |                           Ollama  qwen2.5-coder:14b  @127.0.0.1:11434
    | <--- validate + clamp + (per-bot fallback to heuristic on any failure) ---
    v
{ bots: [ { id, valuation, interest, bid, banter } ] }  ->  game renders signals, resolves
```

Why server-side and not browser-to-Ollama directly: keeps model access on `127.0.0.1`
(no CORS, no exposed endpoint), reuses `AIService` + usage tracking, and lets the program
enforce validation the browser cannot be trusted to do.

---

## 4. Model and data flow

**Sent to the model** (public information only, once per round, all three bots in a single
call to amortize latency):

- the item: `name`, `tags`, and its **clue** - never the exact `item.value` (bots are
  supposed to have noisy knowledge, matching the current `rand(0.72,1.28)` design);
- per bot: personality id, remaining `money`, owned tag counts / set progress, and
  `favored` set for the collector;
- `round` and rounds remaining.

**Never sent**: other participants' bids or private valuations, and the true item value.
Withholding hidden state is also the anti-cheat control (section 6) - the model cannot leak
what it never receives.

**Returned** (strict JSON schema):

```json
{ "bots": [ { "id": "rival", "valuation": 0, "interest": "strong|interested|watching|cool",
              "bid": 0, "banter": "<= 80 chars" } ] }
```

---

## 5. Prompts as design components

Prompts are **versioned design artifacts**, not throwaway strings. Each personality gets a
system prompt describing its strategy (Collector completes sets; Trader arbitrages value;
Rival denies the player's focus tag) stored in `config/roguelite-personas.json` so game
designers can tune behavior without touching code. Generation uses low temperature for
consistency and a fixed Ollama `seed` per round for reproducible playtests. The schema
itself (section 4) is part of the design: it forces the model to commit to a bid and a
tier rather than free-form prose.

---

## 6. Validation

The server never trusts raw model output:

1. **Schema**: strict JSON schema; a parse failure routes that response to fallback.
2. **Bounds**: `bid` clamped to `[0, money]`; `valuation` clamped to a sane band derived
   from the item clue; banter truncated to 80 chars.
3. **Consistency**: if the declared `interest` tier contradicts the `bid`, the tier is
   recomputed from the bid using the existing `interestSignal` thresholds, so the visible
   signal never lies about the sealed bid.
4. **Anti-cheat**: because hidden state is never sent (section 4), the model cannot bid
   against information a fair player would not have.
5. **Testability**: all of the above is pure and unit-testable with a mock `AIService`
   returning fixture payloads (section 9).

---

## 7. Failure modes and fallback

| failure | detection | response |
|---------|-----------|----------|
| Ollama unreachable / down | fetch error | heuristic for all bots; game continues |
| request timeout (60s) | `AbortError` (`src/ai.js`) | heuristic for all bots |
| malformed / non-JSON output | schema/parse check | heuristic for the affected bot |
| out-of-range field | bounds check (section 6) | clamp / repair |
| latency spike | slow response | prefetch at item draw; cache per round; optional 7b model |

The invariant: **any failure degrades to the section 1 heuristic**, so the game is never
blocked and the AI is a strict enhancement. This is exactly the `AI_NATIVE=off` arm used
for the AI-on/AI-off comparison judges expect.

---

## 8. Latency, cost, and privacy

- **Latency**: `qwen2.5-coder:14b` locally is roughly 1-3s for one batched 3-bot decision.
  Mitigations: prefetch while the player reads the clues (`drawItem`), batch all bots into
  one call, and allow a smaller model (`qwen2.5-coder:7b`, already installed) for speed.
- **Cost**: **zero external API cost** - inference is entirely local. The only cost is
  local compute / electricity. No per-token billing, no quota to exhaust.
- **Privacy**: all inference stays on `127.0.0.1:11434`; only synthetic game state leaves
  the browser to the same-host server, and nothing goes to any cloud provider. There is no
  PII in the payload. This is a deliberate local-first posture consistent with the rest of
  the platform.

---

## 9. Verification and rollout

- **Harness**: a `node --test` suite drives the decision function with a mock `AIService`
  and asserts clamping, tier-consistency, and per-bot fallback; registered as a board
  harness so verification is program-decided, not self-declared.
- **Phased rollout**: enable the model for **one** opponent first (Rival - the most
  interactive, since it reacts to the player), compare win-rate and score telemetry against
  the heuristic, then extend to all three.
- **Human playtest**: per the judging guidance, "fun" is judged by people, not by the AI.
  AI-on vs AI-off builds must be played silently by 5-10 testers; AI structural review is
  not sufficient evidence of enjoyment.
- **Board-native**: this document was produced as a scoped board task
  (`docs/GAME-AI-DESIGN.md`); the implementation lands as follow-up scoped tasks - a server
  route, `config/roguelite-personas.json`, the game-client wiring, and the test harness -
  each verified and reviewed through the same loop.

---

## 10. Open questions and risks

- **Determinism across model versions**: pin the model tag and seed; snapshot fixtures so a
  model upgrade cannot silently change balance.
- **Banter safety**: add an output filter so opponent banter can never be offensive; keep
  it short and on-theme.
- **Difficulty balance**: an AI opponent may be too strong or too weak; tune via the
  personas config and the scarcity/aggression bounds rather than code edits.
- **Measuring impact**: define the AI-on/off metric up front (score delta, item-contention
  changes) so the T2 claim is evidenced, not asserted.

---

_Keep this document in sync with `public/roguelite.html` and `src/ai.js`; when the
heuristics or the AI service change, update the referenced sections here._