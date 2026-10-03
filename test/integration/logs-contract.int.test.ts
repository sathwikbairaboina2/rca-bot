import { CloudWatchLogsClient, CreateLogGroupCommand, CreateLogStreamCommand, PutLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAlarmStateChange } from "../../src/core/alarmEvent.js";
import { CATALOG, incidentWindow, planQuery } from "../../src/core/catalog.js";
import type { LogEvent, Row } from "../../src/core/types.js";
import { CloudWatchQueryRunner, FixtureQueryRunner } from "../../src/ports/queryRunner.js";
import { getScenario } from "../../src/sim/scenarios.js";
import { simulate } from "../../src/sim/simulate.js";

const enabled = process.env.RCA_LOCALSTACK === "1";

/** Numbers are compared to 3 decimals; everything else must match exactly. */
function normalize(rows: Row[]): string {
  const norm = rows.map((r) => Object.fromEntries(Object.entries(r).sort().map(([k, v]) => [k, /^-?\d+(\.\d+)?$/.test(v) ? String(Number(Number(v).toFixed(3))) : v])));
  return JSON.stringify(norm);
}

describe.skipIf(!enabled)("Logs Insights contract vs LocalStack (set RCA_LOCALSTACK=1)", () => {
  it("runs every catalog template on LocalStack and reports where it differs from fixture mode", async () => {
    const client = new CloudWatchLogsClient({ endpoint: "http://localhost:5351", region: "us-east-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
    const sim = await simulate(getScenario("ddb-throttle-40"), { seed: 1001 });
    const alarm = parseAlarmStateChange(sim.alarmEvents.find((e) => (e as any).detail.alarmName === sim.scenario.expectedAlarm));
    const shift = Date.now() - 5 * 60_000 - alarm.timeMs;
    const logs: LogEvent[] = sim.logs.map((e) => ({ ...e, timestamp: e.timestamp + shift }));
    const window = incidentWindow(alarm.timeMs + shift);

    for (const group of sim.logGroups) {
      await client.send(new CreateLogGroupCommand({ logGroupName: group })).catch(() => {});
      await client.send(new CreateLogStreamCommand({ logGroupName: group, logStreamName: "s1" })).catch(() => {});
      const events = logs.filter((e) => e.logGroup === group && e.timestamp >= window.startMs && e.timestamp < window.endMs);
      for (let i = 0; i < events.length; i += 1000) {
        await client.send(new PutLogEventsCommand({
          logGroupName: group, logStreamName: "s1",
          logEvents: events.slice(i, i + 1000).map((e) => ({ timestamp: e.timestamp, message: e.message })),
        }));
      }
    }

    const cw = new CloudWatchQueryRunner(client, { pollMs: 1000, timeoutMs: 60_000 });
    const fx = new FixtureQueryRunner(logs);
    const table: Record<string, "match" | "differs" | "failed"> = {};
    for (const [i, t] of CATALOG.entries()) {
      const q = planQuery(`q${i + 1}`, { templateId: t.id, logGroups: sim.logGroups, ...(t.usesFilterValue ? { filterValue: "order" } : {}) }, window);
      const [a, b] = await Promise.all([cw.run(q), fx.run(q)]);
      table[t.id] = a.status !== "Complete" ? "failed" : normalize(a.rows) === normalize(b.rows) ? "match" : "differs";
    }
    console.table(table);
    mkdirSync("bench/results", { recursive: true });
    writeFileSync("bench/results/logs-contract.json", JSON.stringify({ schema: 1, env: "localstack", scenario: "ddb-throttle-40", seed: 1001, templates: table }, null, 2));
    // "differs" is the point of the report (ADR 0002); only a failed StartQuery is a test failure.
    expect(Object.values(table).filter((v) => v === "failed")).toEqual([]);
  });
});
