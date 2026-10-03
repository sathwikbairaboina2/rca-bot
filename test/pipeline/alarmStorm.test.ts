import { describe, expect, it } from "vitest";
import { buildAlarmStateChangeEvent } from "../../src/core/alarmEvent.js";
import { ScriptedModel } from "../../src/model/scripted.js";
import { investigate } from "../../src/pipeline/investigate.js";
import { makeDeps, simFor } from "../support/pipelineDeps.js";

const ORDERS = "/aws/lambda/rca-demo-orders";
const plan = JSON.stringify({ queries: [{ templateId: "timeouts", logGroups: [ORDERS] }] });
const none = JSON.stringify({ hypotheses: [] });

describe("alarm storm (I5)", () => {
  it("5 simultaneous alarms for one service produce one investigation and two model calls", async () => {
    const sim = await simFor("payments-timeout-30");
    const model = new ScriptedModel([plan, none, plan, none]);
    const t = makeDeps(sim, model);
    const base = t.clock.now;
    const ev = (name: string, dt: number, metric: string) =>
      buildAlarmStateChangeEvent({ alarmName: name, state: "ALARM", timeMs: base + dt, reason: "r", metricNamespace: "AWS/ApiGateway", metricName: metric });
    const events = [
      ev("orders-5xx-rate", 0, "5XXError"), ev("orders-5xx-rate", 10_000, "5XXError"), ev("orders-5xx-rate", 20_000, "5XXError"),
      ev("orders-p99-latency", 30_000, "Latency"), ev("orders-p99-latency", 90_000, "Latency"),
    ];
    const reports = await Promise.all(events.map((e) => investigate(e, t.deps)));
    expect(reports.filter((r) => r.status !== "SUPPRESSED")).toHaveLength(1);
    expect(reports.filter((r) => r.status === "SUPPRESSED")).toHaveLength(4);
    expect(model.requests).toHaveLength(2);

    const incidentId = reports.find((r) => r.status !== "SUPPRESSED")!.incidentId;
    const stored = await t.store.getIncident(incidentId);
    expect(stored!.meta.alarms).toHaveLength(5);
    expect(new Set(stored!.meta.alarms)).toEqual(new Set(["orders-5xx-rate", "orders-p99-latency"]));

    t.clock.now = base + 11 * 60_000;
    const later = await investigate(ev("orders-5xx-rate", 11 * 60_000, "5XXError"), t.deps);
    expect(later.status).not.toBe("SUPPRESSED");
    expect(later.incidentId).not.toBe(incidentId);
  }, 30_000);
});
