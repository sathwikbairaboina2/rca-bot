import { beforeAll, describe, expect, it } from "vitest";
import { parseAlarmStateChange } from "../../src/core/alarmEvent.js";
import { incidentWindow, renderQuery } from "../../src/core/catalog.js";
import { evaluateQuery } from "../../src/core/insights/evaluate.js";
import { loadScenarios, getScenario } from "../../src/sim/scenarios.js";
import { simulate, type SimulationResult } from "../../src/sim/simulate.js";

const SEED = 1001;
const sims = new Map<string, SimulationResult>();

beforeAll(async () => {
  for (const s of loadScenarios()) sims.set(s.id, await simulate(s, { seed: SEED }));
}, 60_000);

function rowsFor(id: string, templateId: string) {
  const sim = sims.get(id)!;
  const alarm = parseAlarmStateChange(sim.alarmEvents.find((e) => (e as { detail: { alarmName: string } }).detail.alarmName === sim.scenario.expectedAlarm));
  const w = incidentWindow(alarm.timeMs);
  const events = sim.logs.filter((e) => e.timestamp >= w.startMs && e.timestamp < w.endMs);
  const sel = { templateId, logGroups: sim.logGroups, ...(templateId === "message_search" ? { filterValue: "x" } : {}) };
  return evaluateQuery(renderQuery(sel), events);
}

describe("scenarios", () => {
  it("loads all 5 sorted and rejects unknown ids", () => {
    expect(loadScenarios().map((s) => s.id)).toEqual(["bad-deploy-v18", "cold-start-storm", "ddb-throttle-40", "payments-5xx-50", "payments-timeout-30"]);
    expect(() => getScenario("nope")).toThrow(/unknown scenario nope; try:/);
  });
});

describe("simulate", () => {
  it.each(loadScenarios().map((s) => [s.id]))("%s fires its expected alarm after the fault starts", (id) => {
    const sim = sims.get(id)!;
    const events = sim.alarmEvents.map((e) => parseAlarmStateChange(e));
    const hit = events.find((e) => e.alarmName === sim.scenario.expectedAlarm);
    expect(hit, "expected alarm fired").toBeDefined();
    expect(hit!.timeMs).toBeGreaterThan(sim.faultStartMs);
    expect(hit!.timeMs).toBeLessThanOrEqual(sim.faultStartMs + 6 * 60_000);
    for (const e of events) expect(e.timeMs).toBeGreaterThan(sim.faultStartMs);
  });

  it("raises no alarm on a healthy baseline", async () => {
    const sim = await simulate(getScenario("ddb-throttle-40"), { seed: SEED, faultMin: 0 });
    expect(sim.alarmEvents).toHaveLength(0);
  });

  it("is deterministic per seed", async () => {
    const s = getScenario("bad-deploy-v18");
    const a = sims.get(s.id)!;
    const b = await simulate(s, { seed: SEED });
    expect(b.logs.slice(0, 50).map((l) => l.message)).toEqual(a.logs.slice(0, 50).map((l) => l.message));
    expect(b.alarmEvents).toEqual(a.alarmEvents);
    const c = await simulate(s, { seed: 1002 });
    expect(c.logs.slice(0, 50).map((l) => l.message)).not.toEqual(a.logs.slice(0, 50).map((l) => l.message));
  });

  it("ddb-throttle-40 signature", () => {
    const r = rowsFor("ddb-throttle-40", "throttling_exceptions");
    expect(r[0]).toMatchObject({ errorType: "ProvisionedThroughputExceededException" });
    expect(Number(r[0]!.n)).toBeGreaterThanOrEqual(20);
  });
  it("payments-5xx-50 signature", () => {
    expect(rowsFor("payments-5xx-50", "downstream_status").some((r) => r.downstreamStatus === "503")).toBe(true);
  });
  it("payments-timeout-30 signature", () => {
    const r = rowsFor("payments-timeout-30", "timeouts");
    expect(r[0]!["@log"]).toBe("/aws/lambda/rca-demo-orders");
    expect(Number(r[0]!.n)).toBeGreaterThanOrEqual(20);
  });
  it("bad-deploy-v18 signature", () => {
    const r = rowsFor("bad-deploy-v18", "status_by_version");
    expect(r.some((x) => x.functionVersion === "18" && x.statusCode === "500")).toBe(true);
    expect(r.some((x) => x.functionVersion === "17" && x.statusCode === "500")).toBe(false);
  });
  it("cold-start-storm signature", () => {
    const orders = rowsFor("cold-start-storm", "cold_starts").find((r) => r["@log"] === "/aws/lambda/rca-demo-orders")!;
    expect(Number(orders.coldStarts) / Number(orders.invocations)).toBeGreaterThan(0.1);
  });

  it("REPORT events carry @type and logs are time-sorted", () => {
    for (const sim of sims.values()) {
      const reports = sim.logs.filter((l) => l.message.startsWith("REPORT "));
      expect(reports.length).toBeGreaterThan(1000);
      expect(reports.every((l) => l.fields?.["@type"] === "REPORT")).toBe(true);
      for (let i = 1; i < sim.logs.length; i++) expect(sim.logs[i]!.timestamp).toBeGreaterThanOrEqual(sim.logs[i - 1]!.timestamp);
    }
  });
});
