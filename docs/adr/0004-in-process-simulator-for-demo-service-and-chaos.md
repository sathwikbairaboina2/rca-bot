# ADR 0004: An in-process simulator runs the real demo-service code under labelled faults

Status: accepted, 2026-10-04

## Context

- The design deploys a demo service and a chaos Lambda, and lets real alarms fire.
- There is no AWS account and no LocalStack token. Even LocalStack does not document alarm evaluation.
- Evals need many labelled incidents, and each one must be cheap and reproducible.

## Decision

- **`src/demo/orders.ts` and `src/demo/payments.ts` hold the handler logic.** Their ports are: clock, rng, logger, `putOrder`, `callPayments`, fault flag and function version. The Lambda entrypoints and the simulator call the same functions.
- **The fault hooks live in the demo code**, not the simulator: `ddb_throttle`, `downstream_5xx`, `timeout`, `bad_deploy` and `cold_start`.
- **`src/sim/simulate.ts` runs the service** at 2 requests per second for 20 baseline minutes plus 10 fault minutes, with a seeded mulberry32 RNG. It emits:
  - JSON app logs, in the Powertools field shape: `level`, `message`, `service`, `timestamp`, `requestId`, `functionVersion`, plus extras;
  - Lambda `REPORT` lines with pre-discovered `@type`, `@duration` and `@initDuration`;
  - `Task timed out` lines.

  It also builds per-minute metrics and evaluates the two alarms the way CloudWatch does (3 consecutive breaching 1-minute periods), then produces the EventBridge "CloudWatch Alarm State Change" event.
- **Every scenario has background noise:**
  - 0.5% `400` validation warnings;
  - 2% cold starts;
  - a benign `payments` deploy 5 minutes in, as a red herring.

  This way the model has to discriminate.
- **We do not use Powertools.** The demo service writes the same JSON fields with a 20-line logger, which keeps the bundle and the dependency surface small.

## What we gave up

- **Real-world timing and noise.** Lambda scaling, real DynamoDB throttling curves and real alarm delays are all absent. Scenarios are only as hard as we made them, so the README says so.
- **Real deployment proof.** The CDK stacks are synthesized and assertion-tested, but this repo never shows them deployed.
