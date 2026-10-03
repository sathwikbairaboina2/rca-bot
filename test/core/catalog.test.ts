import { describe, expect, it } from "vitest";
import {
  CatalogError, CATALOG, clampWindow, incidentWindow, lintCatalog, renderQuery, validateSelection, MAX_WINDOW_MS,
} from "../../src/core/catalog.js";

const G1 = "/aws/lambda/rca-demo-orders";
const G2 = "/aws/lambda/rca-demo-payments";
const ALLOWED = [G1, G2];
const sel = (filterValue: unknown) => ({ templateId: "message_search", logGroups: [G1], filterValue });

describe("catalog", () => {
  it("lints all templates", () => {
    const r = lintCatalog();
    expect(r).toHaveLength(8);
    expect(CATALOG).toHaveLength(8);
    expect(r.every((x) => x.ok)).toBe(true);
  });

  it.each([
    'a" | display @message', "a | stats count(*)", "a`b", "a\nb", "a\\b", "/abc/", "filter 1=1", "x".repeat(81), "", 'a"',
  ])("rejects injection filterValue %j", (v) => {
    expect(() => validateSelection(sel(v), ALLOWED)).toThrow(CatalogError);
  });

  it.each(["ProvisionedThroughputExceededException", "Task timed out", "orders/v18: 503"])("allows %j", (v) => {
    expect(validateSelection(sel(v), ALLOWED).filterValue).toBe(v);
  });

  it("rejects bad selections", () => {
    const bad: unknown[] = [
      { templateId: "drop_everything", logGroups: [G1] },
      { templateId: "errors_by_message", logGroups: ["/aws/lambda/other"] },
      { templateId: "errors_by_message", logGroups: [] },
      { templateId: "errors_by_message", logGroups: ["a", "b", "c", "d", "e", "f"] },
      { templateId: "errors_by_message", logGroups: [G1], queryString: "fields *" },
      { templateId: "errors_by_message", logGroups: [G1], filterValue: "x" },
      { templateId: "message_search", logGroups: [G1] },
      null,
      "string",
    ];
    for (const b of bad) {
      const allowed = (b as { logGroups?: string[] } | null)?.logGroups?.length === 6 ? ["a", "b", "c", "d", "e", "f"] : ALLOWED;
      expect(() => validateSelection(b, allowed), JSON.stringify(b)).toThrow(CatalogError);
    }
  });

  it("de-duplicates log groups", () => {
    const s = validateSelection({ templateId: "errors_by_message", logGroups: [G1, G2, G1] }, ALLOWED);
    expect(s.logGroups).toEqual([G1, G2]);
  });

  it("renders message_search", () => {
    expect(renderQuery({ templateId: "message_search", logGroups: ["g"], filterValue: "Task timed out" })).toBe(
      'filter @message like "Task timed out" | fields @timestamp, @log, level, message, errorType | sort @timestamp desc | limit 20',
    );
  });

  it("builds and clamps windows", () => {
    const T = Date.UTC(2026, 9, 3, 10, 0);
    const w = incidentWindow(T);
    expect(w.endMs).toBe(T + 2 * 60_000);
    expect(w.endMs - w.startMs).toBe(32 * 60_000);
    expect(clampWindow({ startMs: w.startMs - 1e7, endMs: w.endMs + 1e7 }, w)).toEqual({ startMs: w.startMs, endMs: w.endMs });
    const big = { startMs: 0, endMs: 4 * 3600_000 };
    const req = { startMs: 0, endMs: 3 * 3600_000 };
    expect(clampWindow(req, big)).toEqual({ startMs: 3 * 3600_000 - MAX_WINDOW_MS, endMs: 3 * 3600_000 });
  });
});
