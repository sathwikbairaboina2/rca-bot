# ADR 0003: Strict citation verification, and confidence computed by code

Status: accepted, 2026-10-04

## Context

A root-cause bot that posts a confident wrong answer is worse than no bot. The model can:
- invent values;
- point at the wrong row;
- cite a query that never ran.

## Decision

`verifyEvidence(hypotheses, results)` is pure and deterministic. A hypothesis is **dropped** when:
- its category is not in the fixed taxonomy, or is `UNKNOWN`;
- it has no evidence;
- **any** evidence reference fails. A reference fails when:
  - its query is unknown or did not complete;
  - its row index is not an integer in range;
  - its quote is empty;
  - a quoted field is missing from the row;
  - `String(quotedValue) !== row[field]`. This is an exact, case-sensitive string match.

The surviving hypotheses keep their order and are re-ranked 1..n. If none survive, the incident is `INCONCLUSIVE`. The Slack card then says "No verified root cause" and shows the top rows of the first two completed queries.

The confidence band comes from `core/confidence.ts`:
- **High:** at least 3 references across at least 2 distinct queries;
- **Medium:** at least 2 references, or at least 2 distinct queries;
- **Low:** anything else.

The model's own confidence is never requested.

The eval harness calls `verifyEvidence` again on what was actually posted. It reports `unverifiedPosted`, which must be 0.

## What we gave up

- **Partial credit.** A mostly right hypothesis with one sloppy citation is dropped, so recall and top-1 accuracy go down.
- **Meaning.** An exact string match proves that a value exists. It does not prove that the value supports the claim: a model can quote a real row and still draw the wrong conclusion. Accuracy against ground truth measures that, not the verifier.
