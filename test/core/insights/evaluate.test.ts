import { describe, expect, it } from "vitest";
import { evaluateQuery } from "../../../src/core/insights/evaluate.js";
import { jsonEvent, reportEvent, textEvent } from "../../support/fixtures.js";

const G = "/aws/lambda/x";

describe("evaluateQuery", () => {
  it("groups errors by message", () => {
    const ev = [
      jsonEvent(1, G, { level: "ERROR", errorType: "A", message: "x" }),
      jsonEvent(2, G, { level: "ERROR", errorType: "A", message: "x" }),
      jsonEvent(3, G, { level: "ERROR", errorType: "B", message: "y" }),
      jsonEvent(4, G, { level: "INFO", message: "ok" }),
    ];
    expect(evaluateQuery('filter level = "ERROR" | stats count(*) as n by errorType, message | sort n desc', ev)).toEqual([
      { errorType: "A", message: "x", n: "2" },
      { errorType: "B", message: "y", n: "1" },
    ]);
  });

  it("compares numbers and strings", () => {
    const ev = [jsonEvent(1, G, { statusCode: 500 })];
    expect(evaluateQuery("filter statusCode >= 500", ev)).toHaveLength(1);
    expect(evaluateQuery('filter statusCode = "500"', ev)).toHaveLength(1);
  });

  it("missing field makes != false", () => {
    expect(evaluateQuery("filter downstreamStatus != 200", [jsonEvent(1, G, { a: 1 })])).toHaveLength(0);
  });

  it("computes percentiles and aggregates", () => {
    const ev = Array.from({ length: 100 }, (_, i) => jsonEvent(i, G, { d: i + 1 }));
    const rows = evaluateQuery("stats pct(d, 99) as p99, pct(d, 50) as p50, avg(d) as a, max(d) as mx, min(d) as mn, sum(d) as s", ev);
    expect(rows).toEqual([{ p99: "99", p50: "50", a: "50.5", mx: "100", mn: "1", s: "5050" }]);
  });

  it("count(field) counts present values; max over system fields", () => {
    const ev = [reportEvent(1, G, { duration: 10 }), reportEvent(2, G, { duration: 20, initDuration: 300 }), reportEvent(3, G, { duration: 30 })];
    const rows = evaluateQuery("stats count(@initDuration) as c, max(@initDuration) as m", ev);
    expect(rows).toEqual([{ c: "1", m: "300" }]);
  });

  it("like is a case-sensitive substring on raw message", () => {
    const ev = [textEvent(1, G, "x Task timed out after 6 seconds"), jsonEvent(2, G, { message: "fine" })];
    expect(evaluateQuery('filter @message like "Task timed out"', ev)).toHaveLength(1);
    expect(evaluateQuery('filter @message like "task timed out"', ev)).toHaveLength(0);
  });

  it("does not throw on non-JSON messages", () => {
    const ev = [textEvent(1, G, "{not json"), textEvent(2, G, "[1,2]"), textEvent(3, G, "plain")];
    expect(evaluateQuery("filter ispresent(level)", ev)).toHaveLength(0);
    expect(evaluateQuery("filter ispresent(@message)", ev)).toHaveLength(3);
  });

  it("flattens nested JSON", () => {
    const rows = evaluateQuery("fields a.b", [jsonEvent(1, G, { a: { b: 7 } })]);
    expect(rows).toEqual([{ "a.b": "7" }]);
  });

  it("defaults to @timestamp and @message", () => {
    const rows = evaluateQuery('filter level = "INFO"', [jsonEvent(Date.UTC(2026, 9, 3), G, { level: "INFO" })]);
    expect(Object.keys(rows[0]!)).toEqual(["@timestamp", "@message"]);
  });

  it("sorts missing last and limits", () => {
    const ev = [jsonEvent(1, G, { v: 2 }), jsonEvent(2, G, { w: 1 }), jsonEvent(3, G, { v: 10 })];
    const asc = evaluateQuery("fields v | sort v asc", ev).map((r) => r.v);
    const desc = evaluateQuery("fields v | sort v desc", ev).map((r) => r.v);
    expect(asc).toEqual(["2", "10", undefined]);
    expect(desc).toEqual(["10", "2", undefined]);
    expect(evaluateQuery("fields v | sort v asc | limit 2", ev)).toHaveLength(2);
  });

  it("supports in", () => {
    const ev = [500, 502, 503].map((s, i) => jsonEvent(i, G, { statusCode: s }));
    expect(evaluateQuery("filter statusCode in [502, 503]", ev)).toHaveLength(2);
  });

  it("exposes @log and @logStream", () => {
    const rows = evaluateQuery("stats count(*) as n by @log", [textEvent(1, G, "a"), textEvent(2, G, "b")]);
    expect(rows).toEqual([{ "@log": G, n: "2" }]);
  });
});
