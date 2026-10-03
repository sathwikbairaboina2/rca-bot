import { describe, expect, it } from "vitest";
import type { AlarmEvent } from "../../src/core/types.js";
import { MemoryIncidentStore } from "../../src/ports/incidentStore.js";
import { dedupeAndBudget, DEFAULT_DEDUPE_CONFIG, newIncidentId } from "../../src/steps/dedupeBudget.js";

const NOW = Date.UTC(2026, 9, 3, 10, 5);
const alarm = (name = "orders-5xx-rate", state: AlarmEvent["state"] = "ALARM"): AlarmEvent => ({
  alarmName: name, service: "orders", state, timeMs: NOW, reason: "r", metricName: "5XXError",
});
let n = 0;
const deps = (store: MemoryIncidentStore) => ({ store, nowMs: NOW, newId: () => `inc-${++n}` });

describe("dedupeAndBudget", () => {
  it("ignores non-ALARM states", async () => {
    const d = await dedupeAndBudget(alarm("a", "OK"), deps(new MemoryIncidentStore()));
    expect(d.action).toBe("IGNORE");
  });
  it("investigates the first alarm and suppresses the next one for the same service", async () => {
    const store = new MemoryIncidentStore();
    const first = await dedupeAndBudget(alarm(), deps(store));
    const second = await dedupeAndBudget(alarm("orders-p99-latency"), deps(store));
    expect(first.action).toBe("INVESTIGATE");
    expect(second.action).toBe("SUPPRESS");
    expect(second.incidentId).toBe(first.incidentId);
    expect((await store.getIncident(first.incidentId!))!.meta.alarms).toEqual(["orders-5xx-rate", "orders-p99-latency"]);
  });
  it("5 concurrent alarms give exactly one investigation (I5)", async () => {
    const store = new MemoryIncidentStore();
    const all = await Promise.all(Array.from({ length: 5 }, () => dedupeAndBudget(alarm(), deps(store))));
    expect(all.filter((d) => d.action === "INVESTIGATE")).toHaveLength(1);
    expect(all.filter((d) => d.action === "SUPPRESS")).toHaveLength(4);
  });
  it("stops at the daily token cap (I4)", async () => {
    const cap = DEFAULT_DEDUPE_CONFIG.dailyTokenCap;
    const store = new MemoryIncidentStore({ dailyTokens: { "2026-10-03": cap - 1000 } });
    const d = await dedupeAndBudget(alarm(), deps(store));
    expect(d.action).toBe("BUDGET_EXHAUSTED");
    expect((await store.getIncident(d.incidentId!))!.meta.status).toBe("BUDGET_EXHAUSTED");
  });
  it("formats incident ids", () => {
    expect(newIncidentId(Date.UTC(2026, 9, 3, 10, 5), () => 0.5)).toMatch(/^inc-202610031005-[0-9a-f]{6}$/);
  });
});
