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

## 2026-10-04 · Claude (Opus lead verifier) · main

### What changed
- Reviewed the v0.1 code (verifier, confidence, pipeline, catalog, Slack card, DynamoDB store) after the crashed run's recovery commits.
- Fix: confidence now counts distinct `(queryId, row)` citations. Citing the same row twice could raise a hypothesis to `High` (I9). Test added.
- Fix: the INCONCLUSIVE Slack card showed raw query rows without redaction. It now masks emails and card numbers like the model prompt does (I12). Test added.
- Re-ran every gate on a clean `npm ci`: typecheck ok, 44 files / 267 tests pass, `8 templates OK`, 3 CDK templates, integration skipped, pack lists the CLI and scenarios, secret grep empty, `docker compose config` ok.
- Re-ran the benches: heuristic top-1 15/15 with 0 unverified posted (median now 528 ms), fabrication 30/30 blocked with 15/15 honest kept. Re-ran the demo against the sink: POSTED DEPENDENCY_THROTTLING, 1 message in the sink.
- Updated `bench/README.md` (heuristic latency) and the DEVDOCS known limits.

### What is left
- The qwen3.8:27b run is still 11 of 15. `eval run` has no resume, so finishing it means a full re-run (1 to 3 hours on this CPU).
- The LocalStack contract test needs a token. v0.2 items are unchanged (see the entry above).
- Five early commits carry another project's subjects (ledger `Ruling:`). History was not rewritten.

### How to verify
Same commands as the entry above. Expect `npm test` to report 44 files and 267 tests.
