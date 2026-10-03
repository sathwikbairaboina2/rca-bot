# ADR 0002: A typed query catalog plus a Logs Insights subset engine ("fixture mode")

Status: accepted, 2026-10-04

## Context

- The model must not write query syntax, for two reasons: injection (I2) and unbounded scans.
- No LocalStack token is available, so no Logs Insights emulator can run here.
- Even with a token, LocalStack's query-language coverage is undocumented.

v0.1 still needs real query results for evals.

## Decision

- **`core/catalog.ts` holds 8 templates.** The model returns only `{templateId, logGroups, filterValue?}`:
  - log groups must come from the incident's allowlist;
  - `filterValue` must match `^[A-Za-z0-9_.:/ -]{1,80}$`;
  - `filterValue` is rendered only as a double-quoted literal.

  The time window is deterministic: from 30 minutes before the alarm to 2 minutes after, clamped to 60 minutes and to the incident window.
- **`core/insights/` implements the subset of the Logs Insights language that the catalog uses.** That is `fields`, `filter`, `stats` (count, sum, avg, min, max, pct) `by`, `sort` and `limit`. Expressions support `and`, `or`, `not`, `= != < <= > >=`, `like "substring"`, `in [...]` and `ispresent()`.
  - Fields are discovered from JSON messages, with nested keys flattened with dots.
  - All result values are strings, as `GetQueryResults` returns them.
  - `rca catalog lint` and a unit test check that every template parses with the engine.
- **The same `QueryRunner` interface has two adapters:**
  - `FixtureQueryRunner` runs the engine over captured or simulated events;
  - `CloudWatchQueryRunner` calls `StartQuery`/`GetQueryResults`, polls with a timeout and calls `StopQuery` when it times out.

  A LocalStack contract test (ADR 0007) compares the two on the same events when a token exists.

## What we gave up

- **Fidelity.** The engine covers only the subset above. Its semantics come from the AWS docs, not from AWS itself:
  - comparisons with a missing field are false;
  - `like` with a string is a substring match;
  - `pct` uses nearest rank, while AWS may interpolate.

  Local eval numbers are labelled `local-fixture` and are not comparable with deployed runs.
- **Flexibility.** The model cannot invent a new query, even a useful one. A new question needs a new template and a review.
