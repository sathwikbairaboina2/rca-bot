import { describe, expect, it } from "vitest";
import { InsightsParseError, parseQuery } from "../../../src/core/insights/parser.js";

describe("parseQuery", () => {
  it("parses a full pipeline", () => {
    expect(parseQuery('filter level = "ERROR" | stats count(*) as n by errorType, message | sort n desc | limit 20')).toEqual([
      { kind: "filter", expr: { kind: "cmp", field: "level", op: "=", value: "ERROR" } },
      { kind: "stats", aggs: [{ fn: "count", arg: "*", as: "n" }], by: ["errorType", "message"] },
      { kind: "sort", field: "n", dir: "desc" },
      { kind: "limit", n: 20 },
    ]);
  });
  it("parses or with like and cmp", () => {
    const [c] = parseQuery('filter errorType like "Throttl" or errorType = "ProvisionedThroughputExceededException"');
    expect(c).toEqual({
      kind: "filter",
      expr: {
        kind: "or",
        left: { kind: "like", field: "errorType", value: "Throttl" },
        right: { kind: "cmp", field: "errorType", op: "=", value: "ProvisionedThroughputExceededException" },
      },
    });
  });
  it("respects precedence", () => {
    const [c] = parseQuery("filter a = 1 or b = 2 and not c = 3");
    expect(c).toEqual({
      kind: "filter",
      expr: {
        kind: "or",
        left: { kind: "cmp", field: "a", op: "=", value: 1 },
        right: {
          kind: "and",
          left: { kind: "cmp", field: "b", op: "=", value: 2 },
          right: { kind: "not", expr: { kind: "cmp", field: "c", op: "=", value: 3 } },
        },
      },
    });
  });
  it("parses ispresent and in keeping literal types", () => {
    const [c] = parseQuery('filter ispresent(downstreamStatus) and statusCode in [500, 502, "503"]');
    expect(c).toEqual({
      kind: "filter",
      expr: {
        kind: "and",
        left: { kind: "ispresent", field: "downstreamStatus" },
        right: { kind: "in", field: "statusCode", values: [500, 502, "503"] },
      },
    });
  });
  it("names aggs by canonical text", () => {
    const [c] = parseQuery("stats pct(@duration, 99), count(*), count(@initDuration)");
    expect(c).toMatchObject({ kind: "stats" });
    expect((c as { aggs: { as: string }[] }).aggs.map((a) => a.as)).toEqual(["pct(@duration, 99)", "count(*)", "count(@initDuration)"]);
  });
  it("keywords are case-insensitive", () => {
    expect(parseQuery("FILTER x = 1 | SORT x DESC | LIMIT 5")).toHaveLength(3);
  });
  it("handles escapes in single-quoted strings", () => {
    const [c] = parseQuery("filter m = 'it\'s'");
    expect((c as { expr: { value: string } }).expr.value).toBe("it's");
  });
  it.each([
    "", "display x", "filter m like /abc/", "filter m = `x`", 'filter m = "a\nb"', "limit 0", "limit 10001",
    "stats pct(x)", "stats sum(*)", "stats count(*) as", "filter (a = 1", "filter a = 1 extra", "fields a |", "filter a == 1",
  ])("rejects %j", (q) => {
    expect(() => parseQuery(q)).toThrow(InsightsParseError);
  });
});
