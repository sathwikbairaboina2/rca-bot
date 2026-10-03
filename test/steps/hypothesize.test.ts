import { describe, expect, it } from "vitest";
import type { QueryResult } from "../../src/core/types.js";
import { ScriptedModel } from "../../src/model/scripted.js";
import { ModelError } from "../../src/model/types.js";
import { hypothesize } from "../../src/steps/hypothesize.js";
import { ctx } from "../support/fixtures.js";

const res = (rows: Record<string, string>[], over: Partial<QueryResult> = {}): QueryResult => ({
  queryId: "q1", templateId: "errors_by_message", logGroups: ["g"], window: { startMs: 0, endMs: 1 }, queryString: "q",
  status: "Complete", rows, bytesScanned: 0, truncated: false, ...over,
});
const h = (rank: number, category = "TIMEOUT") => ({ rank, category, summary: "s", evidence: [{ queryId: "q1", row: 0, quote: { n: "1" } }] });
const out = (...hs: unknown[]) => JSON.stringify({ hypotheses: hs });
const rows = [{ n: "1" }];

describe("hypothesize", () => {
  it("returns hypotheses sorted by rank", async () => {
    const r = await hypothesize(ctx, [res(rows)], new ScriptedModel([out(h(2, "BAD_DEPLOY"), h(1))]));
    expect(r.valid).toBe(true);
    expect(r.hypotheses.map((x) => x.rank)).toEqual([1, 2]);
  });
  it("ends inconclusive after two malformed outputs (I10)", async () => {
    const r = await hypothesize(ctx, [res(rows)], new ScriptedModel(["{", out(h(1, "NETWORK"))]));
    expect(r).toMatchObject({ valid: false, hypotheses: [], calls: 2 });
    expect(r.notes.join(" ")).toContain("invalid twice");
  });
  it("recovers when the second attempt is valid", async () => {
    const r = await hypothesize(ctx, [res(rows)], new ScriptedModel(["{", out(h(1))]));
    expect(r).toMatchObject({ valid: true, calls: 2 });
    expect(r.hypotheses).toHaveLength(1);
  });
  it("recovers from a model error", async () => {
    const r = await hypothesize(ctx, [res(rows)], new ScriptedModel([new ModelError("timeout"), out(h(1))]));
    expect(r.valid).toBe(true);
  });
  it("redacts PII before the prompt leaves the process (I12)", async () => {
    const m = new ScriptedModel([out()]);
    await hypothesize(ctx, [res([{ message: "charge declined for jane@example.com card 4111 1111 1111 1111", n: "3" }])], m);
    const user = m.requests[0]!.user;
    expect(user).toContain("[email]");
    expect(user).toContain("[card]");
    expect(user).not.toContain("jane@example.com");
    expect(user).not.toContain("4111");
  });
  it("makes no model call when there is nothing to analyse", async () => {
    const m = new ScriptedModel([]);
    const r = await hypothesize(ctx, [res([]), res([], { queryId: "q2", status: "Failed", error: "x" })], m);
    expect(m.requests).toHaveLength(0);
    expect(r).toMatchObject({ valid: true, calls: 0, hypotheses: [] });
  });
});
