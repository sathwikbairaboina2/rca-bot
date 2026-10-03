import { describe, expect, it } from "vitest";
import { verifyEvidence } from "../../src/core/verifyEvidence.js";
import type { Evidence, Hypothesis, QueryResult } from "../../src/core/types.js";

const window = { startMs: 0, endMs: 1 };
const mk = (queryId: string, status: QueryResult["status"], rows: Record<string, string>[]): QueryResult => ({
  queryId, templateId: "t", logGroups: ["g"], window, queryString: "q", status, rows, bytesScanned: 0, truncated: false,
});
const results = [
  mk("q1", "Complete", [{ errorType: "ProvisionedThroughputExceededException", n: "212" }, { errorType: "ValidationError", n: "3" }]),
  mk("q2", "Complete", [{ functionVersion: "17", statusCode: "201", n: "900" }]),
  mk("q3", "Failed", []),
];
const hyp = (evidence: Evidence[], category = "DEPENDENCY_THROTTLING"): Hypothesis => ({ rank: 1, category, summary: "s", evidence });
const ev = (queryId: string, row: number, quote: Record<string, unknown>): Evidence => ({ queryId, row, quote: quote as Evidence["quote"] });

describe("verifyEvidence", () => {
  it.each([
    [ev("q1", 0, { errorType: "ProvisionedThroughputExceededException" })],
    [ev("q2", 0, { functionVersion: 17 })],
    [ev("q1", 0, { errorType: "ProvisionedThroughputExceededException", n: "212" })],
  ])("verifies a matching quote %#", (e) => {
    const v = verifyEvidence([hyp([e])], results);
    expect(v.verified).toHaveLength(1);
    expect(v.dropped).toHaveLength(0);
  });

  it.each([
    [ev("q1", 0, { errorType: "ThrottlingException" }), "value mismatch"],
    [ev("q1", 0, { errorType: "provisionedThroughputExceededException" }), "value mismatch"],
    [ev("q1", 0, { errorType: "ProvisionedThroughputExceededException " }), "value mismatch"],
    [ev("q2", 0, { functionVersion: 17.0 as unknown as string, statusCode: "201.0" }), "value mismatch"],
    [ev("q1", 5, { errorType: "x" }), "out of range"],
    [ev("q1", -1, { errorType: "x" }), "out of range"],
    [ev("q1", 1.5, { errorType: "x" }), "out of range"],
    [ev("q9", 0, { errorType: "x" }), "unknown queryId"],
    [ev("q3", 0, { errorType: "x" }), "did not complete"],
    [ev("q1", 0, {}), "empty quote"],
    [ev("q1", 0, { region: "us-east-1" }), "not in"],
    [ev("q1", 0, { errorType: { a: 1 } }), "non-scalar"],
  ])("drops %# with reason", (e, reason) => {
    const v = verifyEvidence([hyp([e])], results);
    expect(v.verified).toHaveLength(0);
    expect(v.dropped[0]!.reason).toContain(reason);
  });

  it("17.0 against \"17\" does not match", () => {
    // JS numbers cannot carry a trailing .0, so a model's 17.0 string form is what must fail
    const v = verifyEvidence([hyp([ev("q2", 0, { functionVersion: "17.0" })])], results);
    expect(v.dropped[0]!.reason).toContain("value mismatch");
  });

  it("is strict: one fabricated reference drops the whole hypothesis", () => {
    const v = verifyEvidence(
      [hyp([ev("q1", 0, { errorType: "ProvisionedThroughputExceededException" }), ev("q1", 0, { errorType: "Nope" })])],
      results,
    );
    expect(v.verified).toHaveLength(0);
    expect(v.dropped).toHaveLength(1);
  });

  it("drops UNKNOWN, unknown category and empty evidence", () => {
    const good = ev("q1", 0, { errorType: "ValidationError" }).quote;
    const e = ev("q1", 1, good);
    expect(verifyEvidence([hyp([e], "UNKNOWN")], results).dropped[0]!.reason).toContain("UNKNOWN");
    expect(verifyEvidence([hyp([e], "NETWORK")], results).dropped[0]!.reason).toContain("unknown category");
    expect(verifyEvidence([hyp([])], results).dropped[0]!.reason).toContain("no evidence");
  });

  it("re-ranks verified hypotheses in order", () => {
    const bad = hyp([ev("q1", 0, { errorType: "Nope" })]);
    const a = { ...hyp([ev("q1", 0, { errorType: "ProvisionedThroughputExceededException" })]), rank: 2 };
    const b = { ...hyp([ev("q2", 0, { functionVersion: "17" })], "BAD_DEPLOY"), rank: 3 };
    const v = verifyEvidence([bad, a, b], results);
    expect(v.verified.map((h) => [h.rank, h.category])).toEqual([[1, "DEPENDENCY_THROTTLING"], [2, "BAD_DEPLOY"]]);
    expect(v.dropped).toHaveLength(1);
  });
});
