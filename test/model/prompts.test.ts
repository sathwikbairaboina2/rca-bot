import { describe, expect, it } from "vitest";
import { CATALOG } from "../../src/core/catalog.js";
import type { QueryResult } from "../../src/core/types.js";
import { ctx } from "../support/fixtures.js";
import { buildPlanPrompt, extractSection, formatResultsForPrompt, parseResultsSection } from "../../src/model/prompts.js";

const result = (rows: Record<string, string>[], over: Partial<QueryResult> = {}): QueryResult => ({
  queryId: "q1", templateId: "errors_by_message", logGroups: ["g"], window: { startMs: 0, endMs: 1 }, queryString: "q",
  status: "Complete", rows, bytesScanned: 0, truncated: false, ...over,
});

describe("prompts", () => {
  it("lists every template and marks filterValue once", () => {
    const p = buildPlanPrompt(ctx);
    for (const t of CATALOG) expect(p).toContain(`- ${t.id}`);
    expect(p.match(/\(needs filterValue\)/g)).toHaveLength(1);
    expect(extractSection(p, "allowed_log_groups")).toBe(JSON.stringify(ctx.logGroups));
  });
  it("round-trips results through format and parse", () => {
    const rows = [{ errorType: "A", n: "2" }, { errorType: "B", n: "1" }];
    const parsed = parseResultsSection(formatResultsForPrompt([result(rows), result([], { queryId: "q2", templateId: "timeouts" })]));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ queryId: "q1", templateId: "errors_by_message", status: "Complete", rows });
    expect(parsed[1]!.rows).toEqual([]);
  });
  it("reports omitted rows", () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ n: String(i) }));
    expect(formatResultsForPrompt([result(rows)])).toContain("(showing 10 of 25 rows)");
  });
  it("redacts emails in rows", () => {
    expect(formatResultsForPrompt([result([{ m: "jane@example.com" }])])).toContain("[email]");
  });
  it("shows failures", () => {
    expect(formatResultsForPrompt([result([], { status: "Failed", error: "bad" })])).toContain("(failed: bad)");
  });
});
