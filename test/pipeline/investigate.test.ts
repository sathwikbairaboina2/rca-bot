import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyEvidence } from "../../src/core/verifyEvidence.js";
import type { LogEvent } from "../../src/core/types.js";
import { HeuristicModel } from "../../src/model/heuristic.js";
import { ScriptedModel } from "../../src/model/scripted.js";
import { MemoryIncidentStore } from "../../src/ports/incidentStore.js";
import { investigate } from "../../src/pipeline/investigate.js";
import { alarmEventOf, makeDeps, simFor } from "../support/pipelineDeps.js";

const ORDERS = "/aws/lambda/rca-demo-orders";
const PAYMENTS = "/aws/lambda/rca-demo-payments";
const plan = (queries: unknown[]) => JSON.stringify({ queries });
const hyps = (...h: unknown[]) => JSON.stringify({ hypotheses: h });

describe("investigate", () => {
  it("end to end with the heuristic model posts a verified throttling root cause", async () => {
    const sim = await simFor("ddb-throttle-40");
    const t = makeDeps(sim, new HeuristicModel());
    const report = await investigate(alarmEventOf(sim), t.deps);
    expect(report.status).toBe("POSTED");
    expect(report.posted[0]!.category).toBe("DEPENDENCY_THROTTLING");
    expect(verifyEvidence(report.posted, report.queries).dropped).toHaveLength(0);
    expect(existsSync(join(t.cardDir, `${report.incidentId}.json`))).toBe(true);
    expect(report.modelCalls).toBe(2);
  }, 30_000);

  it("caps queries at the budget even if the model asks for 20 (I3)", async () => {
    const sim = await simFor("ddb-throttle-40");
    const templates = ["errors_by_message", "status_by_version", "latency_by_version", "throttling_exceptions", "cold_starts", "downstream_status", "timeouts", "message_search"];
    const sets = [[ORDERS], [PAYMENTS], [ORDERS, PAYMENTS]];
    const sels = sets.flatMap((logGroups) =>
      templates.map((templateId) => ({ templateId, logGroups, ...(templateId === "message_search" ? { filterValue: "error" } : {}) })),
    ).slice(0, 20);
    const t = makeDeps(sim, new ScriptedModel([plan(sels), hyps()]));
    const report = await investigate(alarmEventOf(sim), t.deps);
    expect(report.queries).toHaveLength(6);
    expect(report.notes).toContain("query budget capped: requested 20, running 6");
    expect((await t.store.getIncident(report.incidentId))!.budget.queriesUsed).toBe(6);
  }, 30_000);

  it("a hypothesis citing a value that is not in the results is dropped and the card says so", async () => {
    const sim = await simFor("ddb-throttle-40");
    const fake = { rank: 1, category: "DEPENDENCY_THROTTLING", summary: "made up", evidence: [{ queryId: "q1", row: 0, quote: { errorType: "ThrottlingException" } }] };
    const t = makeDeps(sim, new ScriptedModel([plan([{ templateId: "errors_by_message", logGroups: [ORDERS] }]), hyps(fake)]));
    const report = await investigate(alarmEventOf(sim), t.deps);
    expect(report.status).toBe("INCONCLUSIVE");
    expect(report.posted).toEqual([]);
    expect(report.dropped).toHaveLength(1);
    expect(readFileSync(join(t.cardDir, `${report.incidentId}.json`), "utf8")).toContain("No verified root cause");
  }, 30_000);

  it("ends inconclusive when the hypothesize output is invalid twice (I10)", async () => {
    const sim = await simFor("ddb-throttle-40");
    const t = makeDeps(sim, new ScriptedModel([plan([{ templateId: "errors_by_message", logGroups: [ORDERS] }]), "{", "{"]));
    const report = await investigate(alarmEventOf(sim), t.deps);
    expect(report.status).toBe("INCONCLUSIVE");
    expect(report.modelCalls).toBe(3);
    expect(report.notes.join(" ")).toContain("invalid twice");
  }, 30_000);

  it("posts a budget card and makes no model call when the daily cap is hit (I4)", async () => {
    const sim = await simFor("ddb-throttle-40");
    const store = new MemoryIncidentStore({ dailyTokens: { "2026-10-03": 2_000_000 } });
    const model = new ScriptedModel([]);
    const t = makeDeps(sim, model, { store });
    const report = await investigate(alarmEventOf(sim), t.deps);
    expect(report.status).toBe("BUDGET_EXHAUSTED");
    expect(model.requests).toHaveLength(0);
    expect(readFileSync(join(t.cardDir, `${report.incidentId}.json`), "utf8")).toContain("Budget exhausted");
  }, 30_000);

  it("redacts PII found in logs before prompting (I12)", async () => {
    const sim = await simFor("ddb-throttle-40");
    const probe = sim.alarmEvents.length && JSON.parse(JSON.stringify(alarmEventOf(sim))) as { time: string };
    const at = Date.parse((probe as { time: string }).time) - 60_000;
    const extra: LogEvent[] = [
      { timestamp: at, logGroup: ORDERS, logStream: "s", message: JSON.stringify({ level: "ERROR", message: "charge declined for jane@example.com", errorType: "CardDeclined" }) },
    ];
    const model = new ScriptedModel([plan([{ templateId: "errors_by_message", logGroups: [ORDERS] }]), hyps()]);
    const t = makeDeps(sim, model, { extraLogs: extra });
    await investigate(alarmEventOf(sim), t.deps);
    const hypPrompt = model.requests[1]!.user;
    expect(hypPrompt).toContain("[email]");
    expect(hypPrompt).not.toContain("jane@example.com");
  }, 30_000);

  it("keeps the incident POSTED when Slack posting fails", async () => {
    const sim = await simFor("ddb-throttle-40");
    const poster = { kind: "file" as const, post: async () => { throw new Error("boom"); } };
    const t = makeDeps(sim, new HeuristicModel(), { poster });
    const report = await investigate(alarmEventOf(sim), t.deps);
    expect(report.status).toBe("POSTED");
    expect(report.notes.join(" ")).toContain("slack post failed");
  }, 30_000);

  it("ignores OK-state events", async () => {
    const sim = await simFor("ddb-throttle-40");
    const t = makeDeps(sim, new ScriptedModel([]));
    const ev = JSON.parse(JSON.stringify(alarmEventOf(sim)));
    ev.detail.state.value = "OK";
    const report = await investigate(ev, t.deps);
    expect(report.notes).toContain("ignored non-ALARM state");
    expect(readdirSync(t.cardDir)).toHaveLength(0);
  });
});
