import { parseAlarmStateChange } from "../core/alarmEvent.js";
import { planQuery } from "../core/catalog.js";
import type {
  AlarmEvent, Hypothesis, IncidentReport, InvestigationContext, PlannedQuery, QueryResult, Usage,
} from "../core/types.js";
import { verifyEvidence, type Verdict } from "../core/verifyEvidence.js";
import type { Model } from "../model/types.js";
import type { ContextSource } from "../ports/contextSource.js";
import type { IncidentStore } from "../ports/incidentStore.js";
import type { QueryRunner } from "../ports/queryRunner.js";
import type { ResultsStore } from "../ports/resultsStore.js";
import type { SlackPoster } from "../ports/slack.js";
import { renderIncidentCard } from "../slack/render.js";
import { dedupeAndBudget, type DedupeConfig, type DedupeDecision } from "../steps/dedupeBudget.js";
import { hypothesize, type HypothesizeOutcome } from "../steps/hypothesize.js";
import { planQueries, type PlanOutcome } from "../steps/planQueries.js";
import { runQueries } from "../steps/runQueries.js";

export interface PipelineDeps {
  store: IncidentStore;
  results: ResultsStore;
  runner: QueryRunner;
  model: Model;
  poster: SlackPoster | null;
  context: ContextSource;
  now: () => number;
  newId: () => string;
  config?: Partial<DedupeConfig>;
  serviceOf?: (alarmName: string) => string;
}

export async function stageDedupe(rawEvent: unknown, deps: PipelineDeps): Promise<DedupeDecision> {
  const alarm = parseAlarmStateChange(rawEvent, deps.serviceOf);
  return dedupeAndBudget(alarm, { store: deps.store, nowMs: deps.now(), newId: deps.newId, ...(deps.config ? { config: deps.config } : {}) });
}

export async function stagePlan(
  incidentId: string, ctx: InvestigationContext, deps: PipelineDeps,
): Promise<{ planned: PlannedQuery[]; outcome: PlanOutcome; notes: string[] }> {
  const outcome = await planQueries(ctx, deps.model);
  await deps.store.addUsage(incidentId, { tokensIn: outcome.usage.inputTokens, tokensOut: outcome.usage.outputTokens });
  // I3: the model may ask for many queries; the per-incident budget decides how many run.
  const granted = await deps.store.consumeQueries(incidentId, outcome.selections.length);
  const planned = outcome.selections.slice(0, granted).map((s, i) => planQuery(`q${i + 1}`, s, ctx.window));
  const notes = [...outcome.notes];
  if (granted < outcome.selections.length) notes.push(`query budget capped: requested ${outcome.selections.length}, running ${granted}`);
  return { planned, outcome, notes };
}

export async function stageHypothesize(
  incidentId: string, ctx: InvestigationContext, results: QueryResult[], deps: PipelineDeps,
): Promise<HypothesizeOutcome> {
  const out = await hypothesize(ctx, results, deps.model);
  await deps.store.addUsage(incidentId, { tokensIn: out.usage.inputTokens, tokensOut: out.usage.outputTokens });
  return out;
}

export async function stageVerify(
  incidentId: string, hyps: Hypothesis[], results: QueryResult[], deps: PipelineDeps,
): Promise<{ verdict: Verdict; status: "POSTED" | "INCONCLUSIVE" }> {
  const verdict = verifyEvidence(hyps, results);
  await deps.store.saveHypotheses(incidentId, verdict.verified, verdict.dropped);
  const status = verdict.verified.length > 0 ? "POSTED" : "INCONCLUSIVE";
  await deps.store.setStatus(incidentId, status);
  return { verdict, status };
}

export async function stagePost(report: IncidentReport, deps: PipelineDeps): Promise<{ location: string | null; note?: string }> {
  if (!deps.poster) return { location: null };
  try {
    const r = await deps.poster.post(renderIncidentCard(report), report.incidentId);
    return { location: r.location };
  } catch (e) {
    return { location: null, note: `slack post failed: ${(e as Error).message}` };
  }
}

const ZERO: Usage = { inputTokens: 0, outputTokens: 0 };

function emptyReport(deps: PipelineDeps, alarm: AlarmEvent, incidentId: string, status: IncidentReport["status"], notes: string[]): IncidentReport {
  return {
    incidentId, service: alarm.service, alarms: [alarm.alarmName], status, openedAtMs: deps.now(), context: null, queries: [],
    posted: [], dropped: [], model: deps.model.id, modelCalls: 0, usage: { ...ZERO }, notes,
  };
}

/** Runs the whole investigation in-process. The Lambda handlers call the same stage functions. */
export async function investigate(rawEvent: unknown, deps: PipelineDeps): Promise<IncidentReport> {
  const decision = await stageDedupe(rawEvent, deps);
  const alarm = decision.alarm;

  if (decision.action === "IGNORE") return emptyReport(deps, alarm, "none", "INVESTIGATING", ["ignored non-ALARM state"]);
  if (decision.action === "SUPPRESS") return emptyReport(deps, alarm, decision.incidentId, "SUPPRESSED", ["grouped into an open incident"]);
  const incidentId = decision.incidentId;

  if (decision.action === "BUDGET_EXHAUSTED") {
    const report = emptyReport(deps, alarm, incidentId, "BUDGET_EXHAUSTED", ["daily token cap reached"]);
    const post = await stagePost(report, deps);
    if (post.note) report.notes.push(post.note);
    return report;
  }

  const ctx = await deps.context.gather(alarm);
  const plan = await stagePlan(incidentId, ctx, deps);
  const queries = await runQueries(plan.planned, { runner: deps.runner, results: deps.results, incidentId, concurrency: 3 });
  await deps.store.addUsage(incidentId, { bytesScanned: queries.reduce((n, q) => n + q.bytesScanned, 0) });
  const hyp = await stageHypothesize(incidentId, ctx, queries, deps);
  const { verdict, status } = await stageVerify(incidentId, hyp.hypotheses, queries, deps);

  const stored = await deps.store.getIncident(incidentId);
  const report: IncidentReport = {
    incidentId,
    service: ctx.service,
    alarms: stored?.meta.alarms ?? [alarm.alarmName],
    status,
    openedAtMs: stored?.meta.openedAtMs ?? deps.now(),
    context: ctx,
    queries,
    posted: verdict.verified,
    dropped: verdict.dropped,
    model: deps.model.id,
    modelCalls: plan.outcome.calls + hyp.calls,
    usage: {
      inputTokens: plan.outcome.usage.inputTokens + hyp.usage.inputTokens,
      outputTokens: plan.outcome.usage.outputTokens + hyp.usage.outputTokens,
    },
    notes: [...plan.notes, ...hyp.notes],
  };
  const post = await stagePost(report, deps);
  if (post.note) report.notes.push(post.note);
  return report;
}
