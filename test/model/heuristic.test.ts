import { describe, expect, it } from "vitest";
import { verifyEvidence } from "../../src/core/verifyEvidence.js";
import { HeuristicModel } from "../../src/model/heuristic.js";
import { HypothesisOutputSchema, parseModelJson, PlanOutputSchema, toModelSchema } from "../../src/model/schemas.js";
import { loadScenarios } from "../../src/sim/scenarios.js";
import { simulate } from "../../src/sim/simulate.js";
import { scenarioPrompt } from "../support/scenarioPrompt.js";

const model = new HeuristicModel();
const schema = toModelSchema(HypothesisOutputSchema);

describe("HeuristicModel", () => {
  it.each(loadScenarios().map((s) => [s.id]))("%s: top hypothesis matches the label and every citation verifies", async (id) => {
    const scenario = loadScenarios().find((s) => s.id === id)!;
    const sim = await simulate(scenario, { seed: 1001 });
    const { results, user } = await scenarioPrompt(sim);
    const out = await model.complete({ purpose: "hypothesize", system: "", user, schema, maxOutputTokens: 700 });
    const parsed = parseModelJson(out.text, HypothesisOutputSchema);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.hypotheses[0]!.category).toBe(scenario.expectedCategory);
    const verdict = verifyEvidence(parsed.value.hypotheses, results);
    expect(verdict.dropped).toEqual([]);
  }, 30_000);

  it("plan output is schema-valid", async () => {
    const user = '<allowed_log_groups>["/a","/b"]</allowed_log_groups>';
    const out = await model.complete({ purpose: "plan", system: "", user, schema: {}, maxOutputTokens: 1 });
    expect(parseModelJson(out.text, PlanOutputSchema).ok).toBe(true);
  });
  it("empty results give no hypotheses", async () => {
    const out = await model.complete({ purpose: "hypothesize", system: "", user: "<context>{}</context>\n<results>\n</results>", schema, maxOutputTokens: 1 });
    expect(JSON.parse(out.text)).toEqual({ hypotheses: [] });
  });
});
