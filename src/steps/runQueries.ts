import type { PlannedQuery, QueryResult } from "../core/types.js";
import type { QueryRunner } from "../ports/queryRunner.js";
import type { ResultsStore } from "../ports/resultsStore.js";

/** Runs the planned queries with bounded concurrency, stores each result, and returns them in plan order. */
export async function runQueries(
  planned: PlannedQuery[],
  deps: { runner: QueryRunner; results: ResultsStore; incidentId: string; concurrency?: number },
): Promise<QueryResult[]> {
  const out: QueryResult[] = new Array(planned.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= planned.length) return;
      const r = await deps.runner.run(planned[i]!);
      await deps.results.put(deps.incidentId, r);
      out[i] = r;
    }
  };
  const n = Math.max(1, Math.min(deps.concurrency ?? 3, planned.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}
