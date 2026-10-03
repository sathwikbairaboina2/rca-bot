import { describe, expect, it } from "vitest";
import { MemoryIncidentStore, type IncidentMeta } from "../../src/ports/incidentStore.js";

const NOW = Date.UTC(2026, 9, 3, 10, 0);
const WINDOW = 10 * 60_000;
const meta = (id: string, service = "orders"): IncidentMeta => ({ incidentId: id, service, alarms: ["a1"], openedAtMs: NOW, status: "INVESTIGATING" });
const open = { nowMs: NOW, windowMs: WINDOW, queriesAllowed: 6 };

describe("MemoryIncidentStore", () => {
  it("groups opens within the window and reopens after it", async () => {
    const s = new MemoryIncidentStore();
    expect(await s.openIncident(meta("inc-1"), open)).toEqual({ opened: true });
    expect(await s.openIncident(meta("inc-2"), open)).toEqual({ opened: false, incidentId: "inc-1" });
    expect(await s.openIncident(meta("inc-3"), { ...open, nowMs: NOW + WINDOW })).toEqual({ opened: false, incidentId: "inc-1" });
    expect(await s.openIncident(meta("inc-3"), { ...open, nowMs: NOW + WINDOW + 1 })).toEqual({ opened: true });
    expect(await s.openIncident(meta("inc-4", "payments"), open)).toEqual({ opened: true });
  });
  it("grants queries up to the budget", async () => {
    const s = new MemoryIncidentStore();
    await s.openIncident(meta("inc-1"), open);
    expect(await s.consumeQueries("inc-1", 4)).toBe(4);
    expect(await s.consumeQueries("inc-1", 4)).toBe(2);
    expect(await s.consumeQueries("inc-1", 1)).toBe(0);
  });
  it("never over-grants under concurrency", async () => {
    const s = new MemoryIncidentStore();
    await s.openIncident(meta("inc-1"), open);
    const got = await Promise.all(Array.from({ length: 10 }, () => s.consumeQueries("inc-1", 1)));
    expect(got.reduce((a, b) => a + b, 0)).toBe(6);
  });
  it("reserves daily tokens only while under the cap", async () => {
    const s = new MemoryIncidentStore();
    expect(await s.reserveDailyTokens("2026-10-03", 60, 100)).toBe(true);
    expect(await s.reserveDailyTokens("2026-10-03", 50, 100)).toBe(false);
    expect(s.dailyTokens("2026-10-03")).toBe(60);
    expect(await s.reserveDailyTokens("2026-10-03", 40, 100)).toBe(true);
  });
  it("reports alarms and budget usage", async () => {
    const s = new MemoryIncidentStore();
    await s.openIncident(meta("inc-1"), open);
    await s.appendAlarm("inc-1", "a2");
    await s.consumeQueries("inc-1", 3);
    await s.addUsage("inc-1", { tokensIn: 5, tokensOut: 2, bytesScanned: 100 });
    const got = await s.getIncident("inc-1");
    expect(got!.meta.alarms).toEqual(["a1", "a2"]);
    expect(got!.budget).toMatchObject({ queriesUsed: 3, tokensIn: 5, tokensOut: 2, bytesScanned: 100 });
    expect(await s.getIncident("nope")).toBeNull();
  });
});
