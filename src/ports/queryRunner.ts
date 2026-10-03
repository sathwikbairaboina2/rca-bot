import { CloudWatchLogsClient, GetQueryResultsCommand, StartQueryCommand, StopQueryCommand } from "@aws-sdk/client-cloudwatch-logs";
import { evaluateQuery } from "../core/insights/evaluate.js";
import type { LogEvent, PlannedQuery, QueryResult, Row } from "../core/types.js";

export interface QueryRunner { run(q: PlannedQuery): Promise<QueryResult> }
export const DEFAULT_MAX_ROWS = 50;

/** Runs catalog queries against in-memory events with the Logs Insights subset engine ("fixture mode", ADR 0002). */
export class FixtureQueryRunner implements QueryRunner {
  private readonly maxRows: number;
  constructor(private readonly events: readonly LogEvent[], opts: { maxRows?: number } = {}) {
    this.maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  }

  async run(q: PlannedQuery): Promise<QueryResult> {
    const groups = new Set(q.logGroups);
    const selected = this.events.filter((e) => groups.has(e.logGroup) && e.timestamp >= q.window.startMs && e.timestamp < q.window.endMs);
    // Approximation: CloudWatch bills scanned bytes of the stored event, which includes metadata we do not model.
    const bytesScanned = selected.reduce((n, e) => n + Buffer.byteLength(e.message), 0);
    try {
      const rows = evaluateQuery(q.queryString, selected);
      const truncated = rows.length > this.maxRows;
      return { ...q, status: "Complete", rows: truncated ? rows.slice(0, this.maxRows) : rows, bytesScanned, truncated };
    } catch (e) {
      return { ...q, status: "Failed", rows: [], bytesScanned, truncated: false, error: (e as Error).message };
    }
  }
}

export interface CloudWatchRunnerOptions {
  pollMs?: number;
  timeoutMs?: number;
  maxRows?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class CloudWatchQueryRunner implements QueryRunner {
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly maxRows: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly client: CloudWatchLogsClient, opts: CloudWatchRunnerOptions = {}) {
    this.pollMs = opts.pollMs ?? 1000;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  async run(q: PlannedQuery): Promise<QueryResult> {
    const failed = (error: string, status: QueryResult["status"] = "Failed"): QueryResult => ({
      ...q, status, rows: [], bytesScanned: 0, truncated: false, error,
    });
    const started = this.now();
    let queryId: string | undefined;
    try {
      const s = await this.client.send(
        new StartQueryCommand({
          logGroupNames: q.logGroups,
          startTime: Math.floor(q.window.startMs / 1000),
          endTime: Math.ceil(q.window.endMs / 1000),
          queryString: q.queryString,
          limit: this.maxRows + 1,
        }),
      );
      queryId = s.queryId;
    } catch (e) {
      return failed((e as Error).message);
    }
    if (!queryId) return failed("StartQuery returned no queryId");

    for (;;) {
      let r;
      try {
        r = await this.client.send(new GetQueryResultsCommand({ queryId }));
      } catch (e) {
        return failed((e as Error).message);
      }
      if (r.status === "Complete") {
        const all: Row[] = (r.results ?? []).map((fields) => {
          const row: Row = {};
          for (const f of fields) if (f.field && f.field !== "@ptr") row[f.field] = f.value ?? "";
          return row;
        });
        const truncated = all.length > this.maxRows;
        return {
          ...q, status: "Complete", rows: truncated ? all.slice(0, this.maxRows) : all,
          bytesScanned: r.statistics?.bytesScanned ?? 0, truncated,
        };
      }
      if (r.status === "Failed" || r.status === "Cancelled" || r.status === "Timeout" || r.status === "Unknown") {
        return failed(`query ended with status ${r.status}`);
      }
      if (this.now() - started > this.timeoutMs) {
        try {
          await this.client.send(new StopQueryCommand({ queryId }));
        } catch {
          // best effort: the query is abandoned either way
        }
        return failed(`query exceeded ${this.timeoutMs} ms`, "Timeout");
      }
      await this.sleep(this.pollMs);
    }
  }
}
