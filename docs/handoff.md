# Handoff

## 2026-10-04 · Claude (Sonnet builder) · main

### What changed
- Built v0.1 from the plan `docs/superpowers/plans/2026-10-04-rca-bot.md`, tasks 1 to 25. The ledger `.superpowers/sdd/2026-10-04-rca-bot/progress.md` has the per-task evidence and every `Ruling:`.
- Core: Logs Insights subset engine, query catalog, strict evidence verifier, computed confidence, redaction.
- Simulator, demo service, chaos flag and the 5 labelled scenarios.
- Pipeline, stores, query runners, models (Ollama, Bedrock, scripted, heuristic, fabricator), Slack card and sink, `rca` CLI, eval harness, fabrication bench.
- Lambda handlers with an esbuild bundle, and three CDK stacks (`RcaDemoService`, `RcaInvestigator`, `RcaChaos`) that synthesize.
- CI workflow, README, DEVDOCS, bench results.

### What is left
- v0.2: Slack interactivity and signature verification (I11), a deploy timeline from AWS, USD pricing, a LocalStack or AWS deploy, more scenarios and hold-outs.
- The LocalStack Logs Insights contract test is written but was not run (no token).
- The review step has not been done. See the ledger rulings first, especially the note about commit subjects.
- Local LLM benchmark: see `bench/README.md` for the measured `n`. The run was started in the background and may be partial.

### How to verify
```bash
npm ci
npm run typecheck
npm test                                              # 44 files, 265 tests, offline
npm run build && node dist/cli/main.js catalog lint   # 8 templates OK
npm run synth                                         # 3 templates in cdk.out/
npm run test:integration                              # skipped without RCA_LOCALSTACK=1
npm run eval:baseline && npm run bench:fabrication    # invariants: unverifiedPostedTotal == 0, all fabrications blocked
npm pack --dry-run
docker compose config --quiet
```
