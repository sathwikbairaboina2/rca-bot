# ADR 0007: Offline tests, synth-only infrastructure, and LocalStack tests behind an env var

Status: accepted, 2026-10-04

## Context

- There is no LocalStack token on this machine, so LocalStack 2026.03+ will not start.
- CDK asset deployment on LocalStack needs a paid plan.
- Docker Desktop and Node 24 are available.

## Decision

- **`npm test` runs offline.** It needs no network, no Docker and no AWS credentials. It covers:
  - Vitest 4.1.11 unit tests;
  - fast-check 4.10.2 property tests;
  - `aws-sdk-client-mock` 4.1.0 for the DynamoDB, S3, CloudWatch Logs, CloudWatch, SSM and Bedrock adapters;
  - `aws-cdk-lib/assertions` for the stacks (IAM allowlist, alarm rule, state machine shape, chaos tag condition, revert rule).
- **`npm run synth` bundles and synthesizes all three stacks.** It is a gate.
- **`test/integration/logs-contract.int.test.ts` runs only when `RCA_LOCALSTACK=1`**, against the endpoint `http://localhost:5351`. It puts the simulated logs, runs every catalog template through `CloudWatchQueryRunner` and `FixtureQueryRunner`, and reports the templates whose results differ. Without the env var it is skipped, with a reason in the test name.
- **Chaos revert uses an EventBridge `rate(1 minute)` rule** that invokes the chaos Lambda with `{"action":"revert-expired"}`. The design called for EventBridge Scheduler. A rule is simpler, and the service code also ignores expired flags.
- **The workflow is Step Functions Standard**, for the visible execution history in a demo.

## What we gave up

- **No deployed end-to-end proof in v0.1.** Wiring mistakes, such as event shapes between states or real IAM denials, are caught only by assertions and by the shared step code that the in-process pipeline exercises.
- **Scheduler's one-shot precision.** Revert can lag by up to 60 s after `until`. The service ignores the flag on time anyway.
