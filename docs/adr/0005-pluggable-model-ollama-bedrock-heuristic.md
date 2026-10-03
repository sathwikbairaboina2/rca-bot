# ADR 0005: A pluggable model, with Ollama locally, Bedrock on AWS and a heuristic baseline

Status: accepted, 2026-10-04

## Context

- Bedrock is not available locally: LocalStack Ultimate is paid, and there are no AWS credentials.
- Ollama on this host serves `qwen3.8:27b`. We measured it on 2026-10-04: it runs on the CPU (`/api/ps` shows `size_vram: 0`), about 4 output tokens per second, 46–92 s for a tiny structured call, and it is shared with other sessions.

## Decision

- **The `Model` interface is `complete({system, user, schema, maxOutputTokens}) → {text, usage, latencyMs}`.** Schemas are zod 4.6.5 objects, converted with `z.toJSONSchema`.
- **`OllamaModel` calls `POST /api/chat`** with `format: <json schema>`, `think: false`, `stream: false`, `options: {temperature: 0, num_ctx: 8192, num_predict}` and `keep_alive: "30m"`. A prototype on 2026-10-04 showed this returns schema-valid JSON with `qwen3.8:27b`, including a zod-generated schema with `propertyNames`.
- **`BedrockModel` uses Converse with one forced tool**, `submit`, whose `inputSchema.json` is the schema. The tool input is the output. It is unit-tested with `aws-sdk-client-mock` and was not run live.
- **`HeuristicModel` is a deterministic rule baseline.** It plans every relevant template and maps signature rows to categories. It shows how much the LLM adds, and it makes the demo work offline in seconds.
- **`FabricatorModel` wraps any model and corrupts citations**, for the verifier bench.
- **Prompts stay small:** at most 10 rows per query, cell values capped at 200 characters, at most 3 hypotheses with 4 evidence references each, `num_predict` 700. This is needed for CPU inference.

## What we gave up

- **Comparability.** Local numbers come from a 27B Q4 model, not from the Claude model Bedrock would use, so the README reports them per model.
- **Speed.** A full local LLM eval takes tens of minutes, so it runs in the background and writes partial results.
