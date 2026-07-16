# Judging Criteria: Harness And Skill Split

This document summarizes the supplied judging criteria and maps them to Team Loop Lite artifacts.

## Validation Summary

The proposed classification is valid:

- Criteria 0, 4, and 5 are suitable for automated harnesses because they depend on files, links, repository history, execution status, cost signals, or repeatable checks.
- Criterion 6 should not be a deterministic harness because NHN fit depends on company context and human reviewer taste.
- Criteria 1, 2, and 3 are mixed. AI can inspect structure and evidence, but human review is needed for fun, surprise, persuasive quality, and whether the team truly understands the design.

One-line policy:

> Use harnesses for repeatable eligibility, repository, and operations checks; use skills for judgement rules that guide AI and human reviewers.

## Harness Drafts

These are installed as DRAFT harnesses by `node tools/judging/install-criteria-artifacts.mjs`.

| Harness ID | Criteria | Purpose | Why Harness |
| --- | --- | --- | --- |
| `judging-submission-integrity` | 0 | Check required submission files, forbidden executable artifacts, configured video path, and configured run link. | Pass/fail eligibility can be checked before subjective review. |
| `judging-repository-history` | 4 | Check commit count, contributor evidence, docs, and obvious secret leakage. | Repository facts are inspectable and repeatable. |
| `judging-ops-stability` | 5 | Check test/check script, operational docs, and optional health URL. | Cost and runtime resilience can be tested or at least probed. |

The shared executable is:

```bash
node tools/judging/check-criteria.mjs all
```

Strict submission integrity mode expects configuration:

```bash
SUBMISSION_ROOT=/path/to/submission \
SUBMISSION_REQUIRED_FILES="README.md;package.json;docs/TECHNICAL.md" \
SUBMISSION_VIDEO=video.mp4 \
SUBMISSION_RUN_URL=https://example.com/play \
node tools/judging/check-criteria.mjs integrity --strict
```

Optional health check:

```bash
SUBMISSION_HEALTH_URL=https://example.com/health \
node tools/judging/check-criteria.mjs ops-stability
```

## Skill Drafts

These are installed as DRAFT skills by `node tools/judging/install-criteria-artifacts.mjs`.

| Skill ID | Criteria | Purpose | Why Skill |
| --- | --- | --- | --- |
| `judging-video-clarity` | 1 | Force the 60-second pitch to show gameplay and AI difference early. | AI can inspect structure, but people must judge interest and surprise. |
| `judging-ai-native-gameplay` | 2 | Require AI-on/off comparison and runtime AI impact evidence. | Objective dependency can be checked, but fun needs playtesting. |
| `judging-technical-documentation` | 3 | Require architecture, model flow, validation, failure handling, cost, latency, and privacy explanation. | Documentation quality must be cross-checked with code and execution. |
| `judging-nhn-fit-human-review` | 6 | Keep NHN fit as advisory positioning, not automatic elimination. | Company fit depends on human context and internal priorities. |

## Recommended Evaluation Pipeline

1. Run `judging-submission-integrity`.
2. Run `judging-repository-history`.
3. Run `judging-ops-stability`.
4. Apply the skill rules to AI review prompts and human reviewer checklists.
5. For criteria 1, run a silent-viewer test with 5-10 people.
6. For criterion 2, run AI-on and AI-off play sessions and compare outcome diversity.
7. For criterion 3, cross-check technical docs against code and observed execution.
8. Treat criterion 6 as a human review note only.

## Final Target Description

The final passing work should be:

> A game that shows AI-generated fun within 60 seconds, proves implementation ability through technical documents and repository history, and runs reliably at controlled cost through the judging period.
