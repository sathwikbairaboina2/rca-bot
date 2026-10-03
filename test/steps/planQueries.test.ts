import { describe, expect, it } from "vitest";
import { ScriptedModel } from "../../src/model/scripted.js";
import { ModelError } from "../../src/model/types.js";
import { planQueries } from "../../src/steps/planQueries.js";
import { ctx } from "../support/fixtures.js";

const G = ctx.logGroups[0]!;
const plan = (queries: unknown[]) => JSON.stringify({ queries });

describe("planQueries", () => {
  it("returns valid selections in one call", async () => {
    const m = new ScriptedModel([plan([{ templateId: "timeouts", logGroups: [G] }])]);
    const out = await planQueries(ctx, m);
    expect(out).toMatchObject({ calls: 1, usedFallback: false, selections: [{ templateId: "timeouts", logGroups: [G] }] });
    expect(m.requests[0]).toMatchObject({ purpose: "plan" });
    expect((m.requests[0]!.schema as any).properties.queries).toBeDefined();
  });
  it("retries once after garbage without falling back", async () => {
    const m = new ScriptedModel(["garbage", plan([{ templateId: "timeouts", logGroups: [G] }])]);
    const out = await planQueries(ctx, m);
    expect(out.calls).toBe(2);
    expect(out.notes).toHaveLength(1);
    expect(out.usedFallback).toBe(false);
  });
  it("falls back after two garbage outputs", async () => {
    const out = await planQueries(ctx, new ScriptedModel(["x", "y"]));
    expect(out.usedFallback).toBe(true);
    expect(out.selections).toHaveLength(6);
  });
  it("survives a model that throws twice", async () => {
    const out = await planQueries(ctx, new ScriptedModel([new ModelError("down"), new ModelError("down")]));
    expect(out.usedFallback).toBe(true);
    expect(out.calls).toBe(2);
  });
  it("falls back when the model returns no queries", async () => {
    expect((await planQueries(ctx, new ScriptedModel([plan([])]))).usedFallback).toBe(true);
  });
  it("rejects invalid selections but keeps valid ones", async () => {
    const m = new ScriptedModel([
      plan([
        { templateId: "timeouts", logGroups: [G] },
        { templateId: "timeouts", logGroups: ["/aws/lambda/other"] },
        { templateId: "message_search", logGroups: [G], filterValue: "a\"b" },
      ]),
    ]);
    const out = await planQueries(ctx, m);
    expect(out.selections).toHaveLength(1);
    expect(out.rejected).toHaveLength(2);
  });
  it("does not cap the selection count", async () => {
    const ids = ["errors_by_message", "status_by_version", "latency_by_version", "throttling_exceptions", "cold_starts", "downstream_status", "timeouts"];
    const many = ids.map((t) => ({ templateId: t, logGroups: [G] }));
    const more = Array.from({ length: 13 }, (_, i) => ({ templateId: "message_search", logGroups: [G], filterValue: `term ${i}` }));
    const out = await planQueries(ctx, new ScriptedModel([plan([...many, ...more])]));
    expect(out.selections).toHaveLength(20);
  });
});
