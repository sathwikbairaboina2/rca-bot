import { describe, expect, it } from "vitest";
import { parseAlarmStateChange } from "../../src/core/alarmEvent.js";
import { incidentWindow } from "../../src/core/catalog.js";
import {
  makeDedupeHandler, makeGatherContextHandler, makeHypothesizeHandler, makePlanHandler, makePostHandler, makeRunQueryHandler, makeVerifyHandler,
  type InvestigationState,
} from "../../src/handlers/investigator.js";
import { ScriptedModel } from "../../src/model/scripted.js";
import { alarmEventOf, makeDeps, simFor } from "../support/pipelineDeps.js";

const ORDERS = "/aws/lambda/rca-demo-orders";
const plan = JSON.stringify({ queries: [{ templateId: "errors_by_message", logGroups: [ORDERS] }] });
const fake = JSON.stringify({
  hypotheses: [{ rank: 1, category: "TIMEOUT", summary: "made up", evidence: [{ queryId: "q1", row: 0, quote: { errorType: "Nope" } }] }],
});

describe("investigator step handlers", () => {
  it("walks the whole state machine contract end to end", async () => {
    const sim = await simFor("ddb-throttle-40");
    const posted: unknown[] = [];
    const t = makeDeps(sim, new ScriptedModel([plan, fake]), { poster: { kind: "file", post: async (m) => { posted.push(m); return { location: "fake://card" }; } } });
    const f = () => t.deps;
    const raw = alarmEventOf(sim);

    const dedupe = (await makeDedupeHandler(f)(raw)) as InvestigationState["dedupe"];
    expect(dedupe.action).toBe("INVESTIGATE");
    const state: InvestigationState = { dedupe };

    state.context = await makeGatherContextHandler(f)(state);
    expect(state.context.window).toEqual(incidentWindow(parseAlarmStateChange(raw).timeMs));

    state.plan = await makePlanHandler(f)(state);
    expect(state.plan.planned.map((p) => p.queryId)).toEqual(["q1"]);

    const ran = await makeRunQueryHandler(f)({ incidentId: dedupe.incidentId, query: state.plan.planned[0]! });
    expect(ran).toMatchObject({ queryId: "q1", status: "Complete" });
    expect(ran.rows).toBeGreaterThan(0);

    state.hypotheses = await makeHypothesizeHandler(f)(state);
    expect(state.hypotheses.hypotheses).toHaveLength(1);

    state.verdict = await makeVerifyHandler(f)(state);
    expect(state.verdict.status).toBe("INCONCLUSIVE");
    expect(state.verdict.verdict.dropped).toHaveLength(1);

    const post = await makePostHandler(f)(state);
    expect(post.location).toBe("fake://card");
    expect(JSON.stringify(posted[0])).toContain("No verified root cause");
  }, 30_000);

  it("suppresses a second alarm for the same service", async () => {
    const sim = await simFor("ddb-throttle-40");
    const t = makeDeps(sim, new ScriptedModel([]));
    const h = makeDedupeHandler(() => t.deps);
    expect(((await h(alarmEventOf(sim))) as { action: string }).action).toBe("INVESTIGATE");
    expect(((await h(alarmEventOf(sim))) as { action: string }).action).toBe("SUPPRESS");
  });

  it("the post step handles the budget-exhausted path with no context", async () => {
    const sim = await simFor("ddb-throttle-40");
    const t = makeDeps(sim, new ScriptedModel([]));
    const alarm = parseAlarmStateChange(alarmEventOf(sim));
    const post = await makePostHandler(() => t.deps)({ dedupe: { action: "BUDGET_EXHAUSTED", incidentId: "inc-b", alarm } });
    expect(post.location).toBeTruthy();
  });
});
