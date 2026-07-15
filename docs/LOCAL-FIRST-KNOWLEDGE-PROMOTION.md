# Knowledge Promotion

The useful rule from the local-first dashboard is simple:

Repeated failures should become program behavior.

## Promotion Ladder

1. Harness
   - Use when the failure can be judged by a deterministic command.
   - Preferred outcome because it is executable and repeatable.
2. Skill
   - Use when the failure is a procedure, judgment habit, or checklist.
   - Good for agent guidance when hard automation is premature.
3. Document
   - Use when the event is one-off, contextual, or not yet repeated.

Do not promote a one-off surprise into a permanent rule unless the blast radius
is high and the rule is cheap.

## Candidate Scoring

Score each candidate from 0 to 2 on each dimension:

| Dimension | 0 | 1 | 2 |
| --- | --- | --- | --- |
| Repetition | one-off | repeated twice | repeated often or expected every run |
| Decidability | needs human judgment | partially automatic | pass/fail by machine |
| Injection | hard to reproduce | possible with setup | easy fixture |
| Isolation | mutates shared state | contained mutation | read-only or temp-only |
| Observability | vague output | pass/fail only | explains why |
| Maintenance value | rarely useful | occasionally useful | protects a core loop |

Verdict:

- `0-4`: keep as notes
- `5-7`: defer or extend an existing check
- `8-10`: build when nearby work touches it
- `11-12`: build now

## Team Loop Adaptation

Team Loop already has the pieces:

- `failure-cases.json` is the failure corpus.
- `harnesses.json` is the executable registry.
- `skills.json` is the procedural registry.
- task creation can auto-apply active harnesses and skills.

The missing local equivalent of `hs-scan` is a small scanner that groups
failures by `kind`, command, path pattern, or manually assigned class and emits
promotion candidates.

## Guardrail

Before scoring a harness candidate, ask:

Where is the real data this harness will inspect?

If the answer is only a proxy such as a filename, timestamp, prefix, or log
phrase, keep it as a skill or document until direct evidence exists.
