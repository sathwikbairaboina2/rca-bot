import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { CloudWatchContextSource } from "../ports/contextSource.js";
import { DynamoIncidentStore } from "../ports/dynamoIncidentStore.js";
import { CloudWatchQueryRunner } from "../ports/queryRunner.js";
import { S3ResultsStore } from "../ports/resultsStore.js";
import { WebhookPoster, type SlackPoster } from "../ports/slack.js";
import { createModel } from "../model/factory.js";
import {
  stageDedupe, stageHypothesize, stagePlan, stagePost, stageVerify, type PipelineDeps,
} from "../pipeline/investigate.js";
import { newIncidentId, type DedupeDecision } from "../steps/dedupeBudget.js";
import type {
  AlarmEvent, DroppedHypothesis, Hypothesis, IncidentReport, InvestigationContext, PlannedQuery, Usage, VerifiedHypothesis,
} from "../core/types.js";
import { cwClient, ddbDoc, logsClient, requireEnv, s3Client, ssmClient } from "./env.js";

type DepsFactory = () => PipelineDeps | Promise<PipelineDeps>;

/** The Step Functions state accumulated by earlier steps (see the state machine in infra/lib/investigator-stack.ts). */
export interface InvestigationState {
  dedupe: { action: DedupeDecision["action"]; incidentId: string; alarm: AlarmEvent };
  context?: InvestigationContext;
  plan?: { planned: PlannedQuery[]; notes: string[]; usage: Usage; calls: number };
  hypotheses?: { hypotheses: Hypothesis[]; valid: boolean; calls: number; usage: Usage; notes: string[] };
  verdict?: { verdict: { verified: VerifiedHypothesis[]; dropped: DroppedHypothesis[] }; status: "POSTED" | "INCONCLUSIVE" };
}

export const makeDedupeHandler = (f: DepsFactory) => async (event: unknown) => stageDedupe(event, await f());

export const makeGatherContextHandler = (f: DepsFactory) => async (state: InvestigationState) =>
  (await f()).context.gather(state.dedupe.alarm);

export const makePlanHandler = (f: DepsFactory) => async (state: InvestigationState) => {
  if (!state.context) throw new Error("plan step needs state.context");
  const { planned, outcome, notes } = await stagePlan(state.dedupe.incidentId, state.context, await f());
  return { planned, notes, usage: outcome.usage, calls: outcome.calls };
};

export const makeRunQueryHandler = (f: DepsFactory) => async (item: { incidentId: string; query: PlannedQuery }) => {
  const deps = await f();
  const result = await deps.runner.run(item.query);
  await deps.results.put(item.incidentId, result);
  return { queryId: result.queryId, status: result.status, rows: result.rows.length };
};

export const makeHypothesizeHandler = (f: DepsFactory) => async (state: InvestigationState) => {
  if (!state.context) throw new Error("hypothesize step needs state.context");
  const deps = await f();
  const results = await deps.results.list(state.dedupe.incidentId);
  // Bytes scanned are recorded here, not in runQuery, so the query workers need no table access.
  await deps.store.addUsage(state.dedupe.incidentId, { bytesScanned: results.reduce((n, r) => n + r.bytesScanned, 0) });
  return stageHypothesize(state.dedupe.incidentId, state.context, results, deps);
};

export const makeVerifyHandler = (f: DepsFactory) => async (state: InvestigationState) => {
  const deps = await f();
  const results = await deps.results.list(state.dedupe.incidentId);
  return stageVerify(state.dedupe.incidentId, state.hypotheses?.hypotheses ?? [], results, deps);
};

export const makePostHandler = (f: DepsFactory) => async (state: InvestigationState) => {
  const deps = await f();
  const { incidentId, alarm } = state.dedupe;
  const budget = state.dedupe.action === "BUDGET_EXHAUSTED";
  const results = budget ? [] : await deps.results.list(incidentId);
  const stored = await deps.store.getIncident(incidentId);
  const report: IncidentReport = {
    incidentId,
    service: alarm.service,
    alarms: stored?.meta.alarms ?? [alarm.alarmName],
    status: budget ? "BUDGET_EXHAUSTED" : (state.verdict?.status ?? "INCONCLUSIVE"),
    openedAtMs: stored?.meta.openedAtMs ?? alarm.timeMs,
    context: state.context ?? null,
    queries: results,
    posted: state.verdict?.verdict.verified ?? [],
    dropped: state.verdict?.verdict.dropped ?? [],
    model: deps.model.id,
    modelCalls: (state.plan?.calls ?? 0) + (state.hypotheses?.calls ?? 0),
    usage: {
      inputTokens: (state.plan?.usage.inputTokens ?? 0) + (state.hypotheses?.usage.inputTokens ?? 0),
      outputTokens: (state.plan?.usage.outputTokens ?? 0) + (state.hypotheses?.usage.outputTokens ?? 0),
    },
    notes: [...(state.plan?.notes ?? []), ...(state.hypotheses?.notes ?? [])],
  };
  return stagePost(report, deps);
};

/** Without a webhook the card is written to the function log, which is enough to read it in CloudWatch. */
export const logPoster: SlackPoster = {
  kind: "file",
  post: async (msg) => {
    console.log(JSON.stringify(msg));
    return { location: "cloudwatch-logs" };
  },
};

async function resolvePoster(): Promise<SlackPoster> {
  const name = process.env.SLACK_WEBHOOK_PARAM;
  if (!name) return logPoster;
  try {
    const r = await ssmClient().send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    return r.Parameter?.Value ? new WebhookPoster(r.Parameter.Value) : logPoster;
  } catch {
    return logPoster;
  }
}

let cachedDeps: PipelineDeps | null = null;
/** Production wiring, built lazily from the function environment. */
export function envDeps(): PipelineDeps {
  if (cachedDeps) return cachedDeps;
  const groups = JSON.parse(requireEnv("LOG_GROUPS_BY_SERVICE")) as Record<string, string[]>;
  cachedDeps = {
    store: new DynamoIncidentStore({ doc: ddbDoc(), tableName: requireEnv("TABLE_NAME") }),
    results: new S3ResultsStore(s3Client(), requireEnv("BUCKET_NAME")),
    runner: new CloudWatchQueryRunner(logsClient()),
    model: createModel(process.env.MODEL_SPEC ?? "heuristic"),
    poster: null,
    context: new CloudWatchContextSource({ cloudwatch: cwClient(), logGroupsByService: groups }),
    now: () => Date.now(),
    newId: () => newIncidentId(Date.now()),
    config: {
      ...(process.env.QUERIES_ALLOWED ? { queriesAllowed: Number(process.env.QUERIES_ALLOWED) } : {}),
      ...(process.env.DAILY_TOKEN_CAP ? { dailyTokenCap: Number(process.env.DAILY_TOKEN_CAP) } : {}),
    },
  };
  return cachedDeps;
}

export const dedupeHandler = makeDedupeHandler(envDeps);
export const gatherContextHandler = makeGatherContextHandler(envDeps);
export const planHandler = makePlanHandler(envDeps);
export const runQueryHandler = makeRunQueryHandler(envDeps);
export const hypothesizeHandler = makeHypothesizeHandler(envDeps);
export const verifyHandler = makeVerifyHandler(envDeps);
export const postHandler = makePostHandler(async () => ({ ...envDeps(), poster: await resolvePoster() }));

