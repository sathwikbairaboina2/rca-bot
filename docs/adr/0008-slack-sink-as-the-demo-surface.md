# ADR 0008: A local Slack sink is the demo surface; a real webhook is optional

Status: accepted, 2026-10-04

## Context

The 30-second wow has to work without a Slack workspace, a token or a public URL.

## Decision

- **`renderIncidentCard(report)` builds Block Kit JSON**, checked by a snapshot test. One message per incident has:
  - a header (alarm, service, time, status);
  - the top verified hypothesis with its computed confidence;
  - up to 5 evidence snippets (query name, quoted fields);
  - the other verified hypotheses;
  - a deploy timeline;
  - "Correct", "Wrong" and "Show raw queries" buttons.

  For an inconclusive result, it shows "No verified root cause" and the top rows instead.
- **There are three posters:**
  - `WebhookPoster` posts to `SLACK_WEBHOOK_URL`;
  - `SinkPoster` posts to `http://localhost:5350/api/chat.postMessage`;
  - `FilePoster` writes to `.rca/slack/<incidentId>.json`.

  The CLI picks the webhook when its env var is set, otherwise the sink if it is reachable, otherwise the file.

  On AWS, the `post` Lambda reads the webhook URL from an SSM SecureString parameter (default `/rca-bot/slack-webhook`). CloudFormation cannot create SecureString parameters, so the parameter is created outside the stack. When it is missing, the card is written to CloudWatch Logs instead. We chose SSM over Secrets Manager to avoid another SDK client and another per-secret monthly cost.
- **`docker/slack-sink/server.mjs` has no dependencies.** It runs on `node:24-alpine` as `rca-bot-slack-sink`, published on 127.0.0.1:5350. It stores posts in memory and serves `GET /` as HTML cards that render the Block Kit sections, context blocks and buttons.

## What we gave up

- **Real Slack rendering.** The sink is an approximation.
- **Working buttons.** Interactivity (the signature-verified feedback, I11) is v0.2, so the buttons render but do nothing.
