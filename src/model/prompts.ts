import { CATALOG } from "../core/catalog.js";
import { prepareRowsForPrompt } from "../core/redact.js";
import { toIso } from "../core/time.js";
import type { InvestigationContext, QueryResult, QueryStatus, Row } from "../core/types.js";

export const PLAN_SYSTEM = [
  "You are the triage planner of an on-call bot for AWS serverless services.",
  "Choose which read-only CloudWatch Logs Insights queries to run, ONLY from the catalog provided.",
  "Rules:",
  '- Reply with JSON: {"queries":[{"templateId":"...","logGroups":["..."],"filterValue":"..."}]}.',
  "- Use only templateIds from <catalog> and only log groups from <allowed_log_groups>.",
  "- Pick at most 6 queries, most useful first.",
  '- Include filterValue only for templates marked "needs filterValue" (letters, digits, spaces and _ . : / - only).',
].join("\n");

export const HYPOTHESIZE_SYSTEM = [
  "You are the root-cause analyst of an on-call bot. Using ONLY the query results provided, propose the most likely root causes of the alarm.",
  "Categories:",
  "- DEPENDENCY_THROTTLING: a dependency such as DynamoDB rejects calls with throttling errors.",
  "- DEPENDENCY_ERRORS: a downstream service returns 5xx errors or is unavailable.",
  "- TIMEOUT: invocations hit the Lambda timeout, usually while waiting on something slow.",
  "- BAD_DEPLOY: errors start with, and are confined to, a newly deployed function version.",
  "- COLD_START_STORM: an unusual number of cold starts with long init durations drives latency.",
  "- CONFIG_ERROR: missing or wrong configuration (environment, permissions, parameters).",
  "- CAPACITY: concurrency or memory limits are reached.",
  "Rules:",
  '- Reply with JSON: {"hypotheses":[{"rank":1,"category":"...","summary":"...","evidence":[{"queryId":"q1","row":0,"quote":{"field":"value"}}]}]}.',
  '- Every hypothesis needs 1-4 evidence items. "row" is the row number shown. "quote" copies one or more fields of that row EXACTLY as shown (same characters, as strings).',
  "- Never cite a field or value that is not shown, and never cite redacted values such as [email] or [card].",
  '- At most 3 hypotheses, most likely first, summary under 200 characters. If nothing is supported by the results, reply {"hypotheses":[]}.',
].join("\n");

const round3 = (n: number) => Number(n.toFixed(3));

export function contextForPrompt(ctx: InvestigationContext) {
  const baselineEnd = ctx.alarm.timeMs - 10 * 60_000;
  return {
    alarm: { name: ctx.alarm.alarmName, metric: ctx.alarm.metricName, reason: ctx.alarm.reason, time: toIso(ctx.alarm.timeMs) },
    service: ctx.service,
    window: { start: toIso(ctx.window.startMs), end: toIso(ctx.window.endMs) },
    deploys: ctx.deploys.map((d) => ({ at: toIso(d.atMs), function: d.functionName, from: d.fromVersion, to: d.toVersion })),
    metrics: ctx.metrics.map((m) => {
      const base = m.points.filter((p) => p.tMs < baselineEnd).map((p) => p.value);
      const inWin = m.points.filter((p) => p.tMs >= ctx.window.startMs && p.tMs <= ctx.window.endMs).map((p) => p.value);
      return {
        name: m.name,
        unit: m.unit,
        baselineAvg: base.length ? round3(base.reduce((a, b) => a + b, 0) / base.length) : null,
        peak: inWin.length ? round3(Math.max(...inWin)) : null,
      };
    }),
  };
}

export function buildPlanPrompt(ctx: InvestigationContext): string {
  const catalog = CATALOG.map((t) => `- ${t.id}${t.usesFilterValue ? " (needs filterValue)" : ""}: ${t.description}`).join("\n");
  return [
    `<context>${JSON.stringify(contextForPrompt(ctx))}</context>`,
    `<allowed_log_groups>${JSON.stringify(ctx.logGroups)}</allowed_log_groups>`,
    "<catalog>",
    catalog,
    "</catalog>",
  ].join("\n");
}

export function formatResultsForPrompt(results: readonly QueryResult[]): string {
  const out: string[] = [];
  for (const r of results) {
    const { rows, omitted } = prepareRowsForPrompt(r.rows);
    let header = `${r.queryId} ${r.templateId} [${r.status}]`;
    if (omitted > 0) header += ` (showing ${rows.length} of ${r.rows.length} rows)`;
    if (r.truncated) header += " (truncated)";
    out.push(header);
    if (r.status !== "Complete") out.push(`  (failed: ${r.error ?? r.status})`);
    else if (rows.length === 0) out.push("  (no rows)");
    else rows.forEach((row, i) => out.push(`  row ${i}: ${JSON.stringify(row)}`));
  }
  return out.join("\n");
}

export function buildHypothesizePrompt(ctx: InvestigationContext, results: readonly QueryResult[]): string {
  return `<context>${JSON.stringify(contextForPrompt(ctx))}</context>\n<results>\n${formatResultsForPrompt(results)}\n</results>`;
}

/** Text between <tag> and </tag>, or null. */
export function extractSection(user: string, tag: string): string | null {
  const open = `<${tag}>`;
  const a = user.indexOf(open);
  if (a < 0) return null;
  const b = user.indexOf(`</${tag}>`, a + open.length);
  if (b < 0) return null;
  return user.slice(a + open.length, b).replace(/^\n/, "").replace(/\n$/, "");
}

export interface ParsedResult { queryId: string; templateId: string; status: QueryStatus; rows: Row[] }

/** Inverse of formatResultsForPrompt, used by the heuristic and fabricator models. */
export function parseResultsSection(text: string): ParsedResult[] {
  const out: ParsedResult[] = [];
  for (const line of text.split("\n")) {
    const h = /^(q\d+) (\S+) \[(\w+)\]/.exec(line);
    if (h) {
      out.push({ queryId: h[1]!, templateId: h[2]!, status: h[3] as QueryStatus, rows: [] });
      continue;
    }
    const r = /^ {2}row (\d+): (.*)$/.exec(line);
    if (r && out.length) {
      try {
        out[out.length - 1]!.rows[Number(r[1])] = JSON.parse(r[2]!) as Row;
      } catch {
        // a malformed row line is ignored: it simply cannot be cited
      }
    }
  }
  return out;
}
