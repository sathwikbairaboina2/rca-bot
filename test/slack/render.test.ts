import { describe, expect, it } from "vitest";
import type { Evidence, IncidentReport, QueryResult, VerifiedHypothesis } from "../../src/core/types.js";
import { escapeMrkdwn, renderIncidentCard, renderTerminal } from "../../src/slack/render.js";

const T = Date.UTC(2026, 9, 3, 10, 0);
const q = (queryId: string, templateId: string, rows: Record<string, string>[]): QueryResult => ({
  queryId, templateId, logGroups: ["g"], window: { startMs: T, endMs: T + 1 }, queryString: "q", status: "Complete", rows, bytesScanned: 0, truncated: false,
});
const ev = (queryId: string, row: number, quote: Record<string, string>): Evidence => ({ queryId, row, quote });
const hyp = (rank: number, category: VerifiedHypothesis["category"], summary: string, evidence: Evidence[]): VerifiedHypothesis => ({
  rank, category, summary, evidence, confidence: "High",
});
const base = (over: Partial<IncidentReport> = {}): IncidentReport => ({
  incidentId: "inc-202610031000-abcdef", service: "orders", alarms: ["orders-5xx-rate"], status: "POSTED", openedAtMs: T,
  context: { alarm: { alarmName: "orders-5xx-rate", service: "orders", state: "ALARM", timeMs: T, reason: "r", metricName: "5XXError" }, service: "orders", window: { startMs: T - 1, endMs: T }, logGroups: ["g"], deploys: [{ atMs: T - 60_000, functionName: "rca-demo-payments", fromVersion: "41", toVersion: "42" }], metrics: [] },
  queries: [q("q1", "throttling_exceptions", [{ errorType: "ProvisionedThroughputExceededException", n: "212" }])],
  posted: [hyp(1, "DEPENDENCY_THROTTLING", "DynamoDB throttling: 212 errors.", [ev("q1", 0, { errorType: "ProvisionedThroughputExceededException" })])],
  dropped: [], model: "heuristic", modelCalls: 2, usage: { inputTokens: 0, outputTokens: 0 }, notes: [], ...over,
});

describe("renderIncidentCard", () => {
  it("matches the POSTED snapshot", () => {
    expect(renderIncidentCard(base())).toMatchSnapshot();
  });
  it("INCONCLUSIVE shows a code block of raw rows", () => {
    const card = renderIncidentCard(base({ status: "INCONCLUSIVE", posted: [], dropped: [{ hypothesis: { rank: 1, category: "TIMEOUT", summary: "s", evidence: [] }, reason: "x" }] }));
    const json = JSON.stringify(card);
    expect(json).toContain("No verified root cause");
    expect(json).toContain("```");
  });
  it("BUDGET_EXHAUSTED says so", () => {
    expect(JSON.stringify(renderIncidentCard(base({ status: "BUDGET_EXHAUSTED", posted: [], context: null, queries: [] })))).toContain("Budget exhausted");
  });
  it("escapes hostile text", () => {
    const h = hyp(1, "TIMEOUT", "<script>&", [ev("q1", 0, { errorType: "<b>" })]);
    const json = JSON.stringify(renderIncidentCard(base({ posted: [h] })));
    expect(json).toContain("&lt;script&gt;&amp;");
    expect(json).not.toContain("<script>");
    expect(escapeMrkdwn("a<b>&c")).toBe("a&lt;b&gt;&amp;c");
  });
  it("shows at most 5 evidence lines", () => {
    const many = [hyp(1, "TIMEOUT", "a", [1, 2, 3, 4, 5].map((i) => ev("q1", 0, { k: `v${i}` }))), hyp(2, "BAD_DEPLOY", "b", [1, 2, 3].map((i) => ev("q1", 0, { k: `w${i}` })))];
    const card = renderIncidentCard(base({ posted: many }));
    const evBlock = (card.blocks.find((b: any) => b.text?.text?.startsWith("*Evidence*")) as any).text.text as string;
    expect(evBlock.split("\n").filter((l) => l.startsWith("•"))).toHaveLength(5);
  });
  it("puts the incident id on every button", () => {
    const actions = renderIncidentCard(base()).blocks.find((b) => b.type === "actions") as any;
    expect(actions.elements.map((e: any) => e.value)).toEqual(Array(3).fill("inc-202610031000-abcdef"));
    expect(actions.elements.map((e: any) => e.action_id)).toEqual(["feedback_correct", "feedback_wrong", "show_raw"]);
  });
  it("renders the terminal form with category and confidence", () => {
    const t = renderTerminal(base());
    expect(t).toContain("DEPENDENCY_THROTTLING");
    expect(t).toContain("confidence");
  });
});
