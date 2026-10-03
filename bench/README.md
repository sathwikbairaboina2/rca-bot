# Benchmarks

Every number here is copied from a file in `bench/results/`. Environment label for all of them: **`local-fixture`**. That means the in-process simulator plus the fixture Logs Insights engine. Nothing here ran on AWS.

## What is measured

| Bench | Command | Measures |
|---|---|---|
| Root-cause accuracy | `rca eval run --model <spec> --scenarios all --repeat 3` | Top-1 and top-2 accuracy on 5 labelled chaos scenarios. Each run uses a different simulator seed (1000, 1001, 1002). Also counts hypotheses posted without valid evidence. |
| Fabrication blocking | `rca eval fabrication --repeat 3` | Injects hypotheses with fabricated citations and counts how many the verifier blocks. |

"Unverified posted" is the key safety number. After each run the harness re-verifies the posted hypotheses against the stored query results with a fresh call to `verifyEvidence`. The target is 0.

## Reproduce

```bash
npm ci
npm run eval:baseline        # heuristic model, writes bench/results/eval-heuristic.json
npm run bench:fabrication    # writes bench/results/fabrication.json
npx tsx src/cli/main.ts eval run --model ollama:qwen3.8:27b --scenarios all --repeat 3 --out bench/results/eval-ollama-qwen3.8-27b.json
```

Both commands exit 1 if the invariant breaks, so CI fails on an unverified posted claim or an unblocked fabrication.

## Results

### Heuristic baseline (`bench/results/eval-heuristic.json`)

| Metric | Value |
|---|---|
| Runs | 15 (5 scenarios x 3 seeds) |
| Top-1 | 100% (15/15) |
| Top-2 | 100% |
| Inconclusive | 0% |
| Unverified posted | 0 |
| Median / p95 latency | 1188 ms / 1602 ms |

The heuristic baseline is a rule-based model written alongside the simulator. Its accuracy shows that the scenarios are separable from the catalog queries. It does **not** show that the bot is smart.

### Fabrication blocking (`bench/results/fabrication.json`)

| Fabrication kind | Blocked / injected |
|---|---|
| One changed character in a quoted value | 10 / 10 |
| Wrong row | 10 / 10 |
| Unknown query id | 5 / 5 |
| Invented field | 5 / 5 |
| **Total** | **30 / 30** |

The honest hypothesis that was sent along with the fabricated ones was kept 15 of 15 times. Unverified posted: 0.

### Local LLM: qwen3.8:27b (`bench/results/eval-ollama-qwen3.8-27b.json`)

| Metric | Value |
|---|---|
| Runs finished | 1 of 15 planned (the run was stopped early: it takes about 15 minutes per run on the CPU here) |
| Top-1 | 100.0% (1/1) |
| Top-2 | 100.0% (1/1) |
| Inconclusive | 0.0% |
| Unverified posted | 0 |
| Errors | 0 |
| Median / p95 latency per investigation | 894167 ms / 894167 ms |
| Tokens (model-reported) | 1617 in / 467 out |

With n=1 this is an anecdote, not a rate: one run is one scenario at one seed. Read it together with the per-scenario table in the JSON file.

## Caveats

- The simulator, the scenarios and the heuristic baseline were written by the same author. The scenarios are not hold-out data (ADR 0004).
- The fixture Logs Insights engine implements a subset of the query language. The LocalStack contract test (`RCA_LOCALSTACK=1`, needs a token) is built to compare it with the real service, but it was **not run** in v0.1 (ADR 0002, ADR 0007).
- Local models run on the CPU here and are shared with other work, so latency numbers are not representative of a GPU or of Bedrock (ADR 0005).
- Token counts are model-reported tokens. No USD figures are given because no price sheet was verified (ADR 0006).
