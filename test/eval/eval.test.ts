import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IncidentReport, QueryResult, VerifiedHypothesis } from "../../src/core/types.js";
import { runFabricationBench } from "../../src/eval/fabricationBench.js";
import { runEval } from "../../src/eval/runEval.js";
import { scoreRun } from "../../src/eval/score.js";
import { ScriptedModel } from "../../src/model/scripted.js";
import { ModelError } from "../../src/model/types.js";

const tmp = () => join(mkdtempSync(join(tmpdir(), "rca-eval-")), "out.json");
const truth = { scenarioId: "s", fault: "timeout", category: "TIMEOUT" as const };
const q: QueryResult = {
  queryId: "q1", templateId: "timeouts", logGroups: ["g"], window: { startMs: 0, endMs: 1 }, queryString: "q", status: "Complete",
  rows: [{ n: "9" }], bytesScanned: 0, truncated: false,
};
const hyp = (rank: number, category: VerifiedHypothesis["category"], quote: Record<string, string> = { n: "9" }): VerifiedHypothesis => ({
  rank, category, summary: "s", confidence: "Low", evidence: [{ queryId: "q1", row: 0, quote }],
});
const report = (posted: VerifiedHypothesis[]): IncidentReport => ({
  incidentId: "i", service: "orders", alarms: ["a"], status: posted.length ? "POSTED" : "INCONCLUSIVE", openedAtMs: 0, context: null,
  queries: [q], posted, dropped: [], model: "m", modelCalls: 0, usage: { inputTokens: 0, outputTokens: 0 }, notes: [],
});

describe("scoreRun", () => {
  it("scores top1, top2, inconclusive and re-verifies posted citations", () => {
    expect(scoreRun(report([hyp(1, "TIMEOUT")]), truth)).toEqual({ top1: true, top2: true, inconclusive: false, unverifiedPosted: 0 });
    expect(scoreRun(report([hyp(1, "BAD_DEPLOY"), hyp(2, "TIMEOUT")]), truth)).toMatchObject({ top1: false, top2: true });
    expect(scoreRun(report([hyp(1, "BAD_DEPLOY"), hyp(2, "CAPACITY"), hyp(3, "TIMEOUT")]), truth)).toMatchObject({ top1: false, top2: false });
    expect(scoreRun(report([]), truth)).toMatchObject({ top1: false, inconclusive: true });
    expect(scoreRun(report([hyp(1, "TIMEOUT", { n: "10" })]), truth).unverifiedPosted).toBe(1);
  });
});

describe("runEval", () => {
  it("runs the heuristic over selected scenarios and writes a complete result file", async () => {
    const outFile = tmp();
    const seen: number[] = [];
    const r = await runEval({ modelSpec: "heuristic", scenarioIds: ["ddb-throttle-40", "bad-deploy-v18"], repeat: 1, outFile, onRun: (_r, i) => seen.push(i) });
    const file = JSON.parse(readFileSync(outFile, "utf8"));
    expect(file).toMatchObject({ complete: true, schema: 1, env: "local-fixture", model: "heuristic" });
    expect(file.runs).toHaveLength(2);
    expect(file.summary).toMatchObject({ n: 2, unverifiedPostedTotal: 0, top1Rate: 1 });
    expect(r.summary.n).toBe(2);
    expect(seen).toEqual([1, 2]);
  }, 60_000);

  it("never crashes when the model fails on every call", async () => {
    const outFile = tmp();
    const model = new ScriptedModel(Array.from({ length: 12 }, () => new ModelError("down")));
    const r = await runEval({ modelSpec: "x", scenarioIds: ["ddb-throttle-40", "payments-5xx-50"], repeat: 1, outFile, model });
    expect(JSON.parse(readFileSync(outFile, "utf8")).runs).toHaveLength(2);
    expect(r.summary.unverifiedPostedTotal).toBe(0);
    expect(r.runs.every((x) => x.top1 === false)).toBe(true);
  }, 60_000);

  it("rejects an unknown scenario", async () => {
    await expect(runEval({ modelSpec: "heuristic", scenarioIds: ["nope"], repeat: 1, outFile: tmp() })).rejects.toThrow(/unknown scenario/);
  });
});

describe("fabrication bench", () => {
  it("blocks every injected fabrication and keeps every honest hypothesis", async () => {
    const outFile = tmp();
    const r = await runFabricationBench({ repeat: 1, outFile });
    expect(r.fabricatedInjected).toBe(10);
    expect(r.fabricatedBlocked).toBe(10);
    expect(r.honestInjected).toBe(5);
    expect(r.honestKept).toBe(5);
    expect(r.unverifiedPostedTotal).toBe(0);
    expect(JSON.parse(readFileSync(outFile, "utf8")).fabricatedBlocked).toBe(10);
  }, 60_000);
});
