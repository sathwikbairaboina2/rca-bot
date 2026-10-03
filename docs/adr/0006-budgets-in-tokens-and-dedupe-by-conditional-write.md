# ADR 0006: Budgets in queries and tokens, and dedupe by conditional write

Status: accepted, 2026-10-04

## Context

- The design caps queries per incident and the daily USD spend.
- We could not verify a current Bedrock price sheet in this session, and the rules forbid invented numbers.
- Alarm storms must not fan out into many model calls.

## Decision

- **Single DynamoDB table:** `pk`/`sk`, TTL `expiresAt`, and the item shapes from the design (`INC#id/META|BUDGET|HYP#n|TRUTH`, `SVC#service/OPEN`). The day counter is `DAY#yyyy-mm-dd/TOKENS` instead of a USD cost item.
- **`tryOpen` is a conditional put** on `SVC#<service>/OPEN` with `attribute_not_exists(pk) OR expiresAt < :now`. The grouping window is 10 minutes. A lost race returns the existing incident, so the event appends its alarm name and ends as `SUPPRESSED` with no model calls.
- **`consumeQueries(id, n)`** grants `min(n, remaining)` with a conditional update, `queriesUsed + :n <= queriesAllowed`. When the condition fails it re-reads and grants what is left.
- **`reserveDailyTokens(day, n, cap)`** is a conditional add. When the cap is reached, the investigation posts "Budget exhausted" and makes no model call. The default cap is 2,000,000 tokens a day.
- **The memory store has the same contract.** Each check-and-set runs synchronously, with no `await` between the check and the write, so concurrent `Promise.all` calls behave like conditional writes.

## What we gave up

- **No USD cap.** v0.2 can price tokens once a dated price sheet is checked.
- **No re-investigation on escalation.** One investigation per incident. New alarms only append to the card.
