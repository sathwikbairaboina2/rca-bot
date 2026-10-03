import type { Category, Evidence, Hypothesis, Row } from "../core/types.js";
import { DEFAULT_PLAN_TEMPLATES } from "../steps/planQueries.js";
import { extractSection, parseResultsSection, type ParsedResult } from "./prompts.js";
import type { Model, ModelRequest, ModelResponse } from "./types.js";

interface Candidate { category: Category; score: number; summary: string; evidence: Evidence[] }

const num = (v: string | undefined) => (v === undefined ? NaN : Number(v));

function find(results: ParsedResult[], templateId: string, pred: (r: Row) => boolean): { result: ParsedResult; row: number } | null {
  for (const result of results) {
    if (result.templateId !== templateId || result.status !== "Complete") continue;
    const row = result.rows.findIndex((r) => r && pred(r));
    if (row >= 0) return { result, row };
  }
  return null;
}

function pickFields(row: Row, fields: string[]): Record<string, string> {
  const q: Record<string, string> = {};
  for (const f of fields) if (row[f] !== undefined) q[f] = row[f]!;
  return q;
}

/**
 * Rule-based baseline. It reads only the prompt, through the same interface as a real model,
 * and every quote it emits is copied from a shown row. It exists to show the scenarios are
 * separable and to exercise the pipeline offline; it is not evidence that the bot is smart.
 */
export class HeuristicModel implements Model {
  readonly id = "heuristic";

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const text = req.purpose === "plan" ? this.plan(req.user) : this.hypothesize(req.user);
    return { text, usage: { inputTokens: 0, outputTokens: 0 }, latencyMs: 0 };
  }

  private plan(user: string): string {
    const groups = JSON.parse(extractSection(user, "allowed_log_groups") ?? "[]") as string[];
    return JSON.stringify({ queries: DEFAULT_PLAN_TEMPLATES.map((templateId) => ({ templateId, logGroups: groups })) });
  }

  private hypothesize(user: string): string {
    const results = parseResultsSection(extractSection(user, "results") ?? "");
    let deployedVersions: string[] = [];
    try {
      const ctx = JSON.parse(extractSection(user, "context") ?? "{}") as { deploys?: { to: string }[] };
      deployedVersions = (ctx.deploys ?? []).map((d) => String(d.to));
    } catch {
      // no context: BAD_DEPLOY cannot be inferred
    }
    const cands: Candidate[] = [];
    const ev = (r: ParsedResult, row: number, quote: Record<string, string>): Evidence => ({ queryId: r.queryId, row, quote });

    const thr = find(results, "throttling_exceptions", (r) => num(r.n) >= 5);
    if (thr) {
      const row = thr.result.rows[thr.row]!;
      const evidence = [ev(thr.result, thr.row, pickFields(row, ["errorType"]))];
      const msg = find(results, "errors_by_message", (r) => r.errorType === row.errorType && r.message !== undefined);
      if (msg) evidence.push(ev(msg.result, msg.row, pickFields(msg.result.rows[msg.row]!, ["errorType", "message"])));
      cands.push({
        category: "DEPENDENCY_THROTTLING", score: num(row.n), evidence,
        summary: `DynamoDB throttling: ${row.n} ${row.errorType} errors in the window.`,
      });
    }

    const to = find(results, "timeouts", (r) => num(r.n) >= 5);
    if (to) {
      const row = to.result.rows[to.row]!;
      cands.push({
        category: "TIMEOUT", score: num(row.n), evidence: [ev(to.result, to.row, pickFields(row, ["@log", "n"]))],
        summary: `Lambda timeouts: ${row.n} invocations of ${row["@log"]} hit the timeout.`,
      });
    }

    const ds = find(results, "downstream_status", (r) => num(r.downstreamStatus) >= 500 && num(r.n) >= 5);
    if (ds) {
      const row = ds.result.rows[ds.row]!;
      const evidence = [ev(ds.result, ds.row, pickFields(row, ["downstream", "downstreamStatus"]))];
      const err = find(results, "errors_by_message", (r) => r.errorType === "DownstreamError");
      if (err) evidence.push(ev(err.result, err.row, pickFields(err.result.rows[err.row]!, ["errorType"])));
      cands.push({
        category: "DEPENDENCY_ERRORS", score: num(row.n), evidence,
        summary: `Downstream ${row.downstream} returned ${row.downstreamStatus} for ${row.n} calls.`,
      });
    }

    const sv = find(results, "status_by_version", (r) => num(r.statusCode) >= 500 && num(r.n) >= 5 && deployedVersions.includes(r.functionVersion ?? ""));
    if (sv) {
      const row = sv.result.rows[sv.row]!;
      cands.push({
        category: "BAD_DEPLOY", score: num(row.n), evidence: [ev(sv.result, sv.row, pickFields(row, ["functionVersion", "statusCode"]))],
        summary: `Version ${row.functionVersion} returned ${row.statusCode} ${row.n} times after a deploy.`,
      });
    }

    const cs = find(results, "cold_starts", (r) => num(r.coldStarts) >= 10 && num(r.coldStarts) / num(r.invocations) > 0.1);
    if (cs) {
      const row = cs.result.rows[cs.row]!;
      cands.push({
        category: "COLD_START_STORM", score: num(row.coldStarts), evidence: [ev(cs.result, cs.row, pickFields(row, ["@log", "coldStarts"]))],
        summary: `Cold start storm: ${row.coldStarts} of ${row.invocations} invocations of ${row["@log"]} were cold.`,
      });
    }

    cands.sort((a, b) => b.score - a.score);
    const hypotheses: Hypothesis[] = cands.slice(0, 3).map((c, i) => ({ rank: i + 1, category: c.category, summary: c.summary, evidence: c.evidence }));
    return JSON.stringify({ hypotheses });
  }
}
