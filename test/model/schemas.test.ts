import { describe, expect, it } from "vitest";
import { HypothesisOutputSchema, parseModelJson, PlanOutputSchema, toModelSchema } from "../../src/model/schemas.js";

const hyp = (over: object = {}) => ({
  hypotheses: [{ rank: 1, category: "TIMEOUT", summary: "s", evidence: [{ queryId: "q1", row: 0, quote: { a: "b" } }], ...over }],
});

describe("model schemas", () => {
  it("emits a JSON schema without $schema and with 8 categories", () => {
    const s = toModelSchema(HypothesisOutputSchema) as any;
    expect(s.$schema).toBeUndefined();
    expect(s.properties.hypotheses.items.properties.category.enum).toHaveLength(8);
  });
  it("accepts fenced JSON", () => {
    const r = parseModelJson("```json\n" + JSON.stringify(hyp()) + "\n```", HypothesisOutputSchema);
    expect(r.ok).toBe(true);
  });
  it("rejects non-JSON with a JSON reason", () => {
    const r = parseModelJson("not json", HypothesisOutputSchema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("JSON");
  });
  it("rejects unknown categories and empty evidence", () => {
    expect(parseModelJson(JSON.stringify(hyp({ category: "NETWORK" })), HypothesisOutputSchema).ok).toBe(false);
    expect(parseModelJson(JSON.stringify(hyp({ evidence: [] })), HypothesisOutputSchema).ok).toBe(false);
  });
  it("rejects unknown template ids in a plan", () => {
    expect(parseModelJson(JSON.stringify({ queries: [{ templateId: "drop", logGroups: ["g"] }] }), PlanOutputSchema).ok).toBe(false);
    expect(parseModelJson(JSON.stringify({ queries: [{ templateId: "timeouts", logGroups: ["g"] }] }), PlanOutputSchema).ok).toBe(true);
  });
});
