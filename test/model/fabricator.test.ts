import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { verifyEvidence } from "../../src/core/verifyEvidence.js";
import { FabricatorModel } from "../../src/model/fabricator.js";
import { HeuristicModel } from "../../src/model/heuristic.js";
import { HypothesisOutputSchema, parseModelJson, toModelSchema } from "../../src/model/schemas.js";
import { getScenario } from "../../src/sim/scenarios.js";
import { simulate } from "../../src/sim/simulate.js";
import { scenarioPrompt } from "../support/scenarioPrompt.js";

const schema = toModelSchema(HypothesisOutputSchema);

describe("FabricatorModel", () => {
  it("injects two fabricated hypotheses above an honest one, and the verifier drops exactly those", async () => {
    const sim = await simulate(getScenario("ddb-throttle-40"), { seed: 1001 });
    const { results, user } = await scenarioPrompt(sim);
    const m = new FabricatorModel(new HeuristicModel(), { seed: 7 });
    const out = await m.complete({ purpose: "hypothesize", system: "", user, schema, maxOutputTokens: 700 });
    const parsed = parseModelJson(out.text, HypothesisOutputSchema);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const hyps = parsed.value.hypotheses;
    expect(hyps).toHaveLength(3);
    expect(hyps[0]!.summary.startsWith("[fabricated:")).toBe(true);
    expect(hyps[1]!.summary.startsWith("[fabricated:")).toBe(true);
    const v = verifyEvidence(hyps, results);
    expect(v.dropped).toHaveLength(2);
    expect(v.verified).toHaveLength(1);
    expect(v.verified[0]!.summary.startsWith("[fabricated")).toBe(false);

    await m.complete({ purpose: "hypothesize", system: "", user, schema, maxOutputTokens: 700 });
    expect(new Set(m.log.fabricated.map((f) => f.kind))).toEqual(new Set(["char", "row", "query", "field"]));
    expect(m.log.honest).toHaveLength(2);
  }, 30_000);

  it("delegates plan calls unchanged", async () => {
    const m = new FabricatorModel(new HeuristicModel(), { seed: 1 });
    const out = await m.complete({ purpose: "plan", system: "", user: '<allowed_log_groups>["/a"]</allowed_log_groups>', schema: {}, maxOutputTokens: 1 });
    expect(JSON.parse(out.text).queries).toHaveLength(6);
  });

  it("a char mutation always changes the cited value (property)", async () => {
    const sim = await simulate(getScenario("ddb-throttle-40"), { seed: 1001 });
    const { user } = await scenarioPrompt(sim);
    const honest = JSON.parse((await new HeuristicModel().complete({ purpose: "hypothesize", system: "", user, schema, maxOutputTokens: 1 })).text).hypotheses[0];
    const original = honest.evidence[0].quote;
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 1e6 }), async (seed) => {
        const m = new FabricatorModel(new HeuristicModel(), { seed });
        const out = JSON.parse((await m.complete({ purpose: "hypothesize", system: "", user, schema, maxOutputTokens: 1 })).text).hypotheses;
        const charHyp = out.find((h: { summary: string }) => h.summary.startsWith("[fabricated:char]"));
        const field = Object.keys(original)[0]!;
        return charHyp.evidence[0].quote[field] !== original[field];
      }),
      { numRuns: 200 },
    );
  }, 60_000);
});
