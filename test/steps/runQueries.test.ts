import { describe, expect, it } from "vitest";
import type { PlannedQuery, QueryResult } from "../../src/core/types.js";
import type { QueryRunner } from "../../src/ports/queryRunner.js";
import { MemoryResultsStore } from "../../src/ports/resultsStore.js";
import { runQueries } from "../../src/steps/runQueries.js";

const planned = (i: number): PlannedQuery => ({ queryId: `q${i}`, templateId: "t", logGroups: ["g"], window: { startMs: 0, endMs: 1 }, queryString: "q" });

describe("runQueries", () => {
  it("never exceeds the concurrency limit and keeps plan order", async () => {
    let inFlight = 0, max = 0;
    const runner: QueryRunner = {
      async run(q): Promise<QueryResult> {
        inFlight++; max = Math.max(max, inFlight);
        await new Promise((r) => setTimeout(r, 5 + (7 - Number(q.queryId.slice(1))))); // later queries finish sooner
        inFlight--;
        return { ...q, status: "Complete", rows: [], bytesScanned: 0, truncated: false };
      },
    };
    const results = new MemoryResultsStore();
    const out = await runQueries(Array.from({ length: 7 }, (_, i) => planned(i + 1)), { runner, results, incidentId: "inc-1" });
    expect(max).toBeLessThanOrEqual(3);
    expect(out.map((r) => r.queryId)).toEqual(["q1", "q2", "q3", "q4", "q5", "q6", "q7"]);
    expect(await results.list("inc-1")).toHaveLength(7);
  });
  it("handles an empty plan", async () => {
    const out = await runQueries([], { runner: { run: async () => { throw new Error("no"); } }, results: new MemoryResultsStore(), incidentId: "i" });
    expect(out).toEqual([]);
  });
});
