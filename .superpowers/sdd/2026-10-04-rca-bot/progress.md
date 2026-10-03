# Ledger: rca-bot v0.1 (2026-10-04)

Plan: `docs/superpowers/plans/2026-10-04-rca-bot.md` (25 tasks)
Spec: `docs/superpowers/specs/2026-10-04-rca-bot.md`
ADRs: `docs/adr/0001`–`0008`
Commits: local commits are authorized. Never push or add remotes.

## Format

Append one line per finished task, in order. Never rewrite earlier lines.

```
Task N: complete (<real test evidence, e.g. "catalog 18/18; typecheck ok">) | commit: "<subject>"
Task N: BLOCKED (<what failed, verbatim error>) | commit: none
Ruling: <deviation from plan> - <why> - <cost>
```

A fresh builder resumes at the first task without a `complete` line. It must check `git log --oneline | head` against this file before starting.

## Gates (Task 25 and review)

| Gate | Command | Pass |
|---|---|---|
| Install | `npm ci` | exit 0 |
| Types | `npm run typecheck` | exit 0 |
| Tests | `npm test` | 0 failures |
| Build + CLI | `npm run build && node dist/cli/main.js catalog lint` | `8 templates OK` |
| Synth | `npm run synth` | 3 templates in `cdk.out/` |
| Integration | `npm run test:integration` | skipped, exit 0 |
| Invariants | `rca eval run --model heuristic ...`, `rca eval fabrication ...` | `unverifiedPostedTotal == 0`, all fabrications blocked |
| Package | `npm pack --dry-run` | has `dist/cli/main.js`, `scenarios/*.json` |
| Secrets | `git grep` from the plan (G8) | no output |
| Compose | `docker compose config --quiet` | exit 0 |

## Planning facts (measured 2026-10-04 by the Opus lead)

- The npm versions in the plan were checked with `npm view`, including `@aws-sdk/*@3.1146.0`, `aws-cdk-lib@2.272.0`, `aws-cdk@2.1144.0`, `zod@4.6.5`, `vitest@4.1.11`, `typescript@5.9.3`, `fast-check@4.10.2` and `aws-sdk-client-mock@4.1.0`.
- **Prototype results:**
  - `z.toJSONSchema` output works;
  - `aws-sdk-client-mock` rejects/resolves DynamoDB transactions and CloudWatch Logs queries;
  - CDK named imports work from ESM under `tsx`;
  - Ollama `format` with a zod schema and `think:false` gives valid JSON from `qwen3.8:27b`.
- **Ollama runs on the CPU here:** `/api/ps` shows `size_vram: 0`, about 4 tok/s, 46–92 s for a tiny call, and the instance is shared with other sessions. Expect the LLM eval to take tens of minutes, so run it in the background.
- **Environment:** Node v24.18.0, npm 11.16, Docker 29.5.3. The `node:24-alpine` and `rhysd/actionlint:1.7.7` images are available. There is no LocalStack token.

## Progress

Task 0 (plan): complete (spec, 8 ADRs, 25-task plan, ledger) | commit: "docs: add rca-bot v0.1 spec, ADRs and implementation plan"
Task 1: complete (rng+time 6/6; typecheck ok) | commit: "chore: scaffold rca-bot package with shared types"
Task 10: complete (functions test:int -> 11 passed (3 files); with DDB down: unit test 18 passed exit 0, test:int -> 'DynamoDB Local not reachable at http://127.0.0.1:5360. Start it with: docker compose up -d dynamodb') | commit: "feat(functions): add DynamoDB store with versioned transactional price writes"
Task 11: complete (functions vitest -> 27 passed (5 files); lint+typecheck clean) | commit: "feat(functions): add price publisher handler with SigV4 AppSync and local shim publishers"
