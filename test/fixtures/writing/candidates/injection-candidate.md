# Injection Candidate

## Spec impact

This fixture proposes a narrowly scoped candidate for exercising brainstorm writing verification.

## One-line

Keep a valid candidate document available so fault injection can remove one required role section.

## Core loop

Change the fixture, run the writing harness, observe the result, and restore a valid changed document.

## Strongest objection

The fixture exists only for verification and must not be mistaken for a product proposal.

## Failure mode

The injection is ineffective if the candidate role or its required sections are no longer recognized.

## Verification

The injected version must fail and the baseline version must pass brainstorm review.

## Playtest

Run the harness injection simulation and inspect the candidate-specific result.

## Open questions

Revisit the fixture if brainstorm candidate requirements change.
