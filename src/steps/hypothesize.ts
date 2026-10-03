import type { Hypothesis, InvestigationContext, QueryResult, Usage } from "../core/types.js";
import { buildHypothesizePrompt, HYPOTHESIZE_SYSTEM } from "../model/prompts.js";
import { HypothesisOutputSchema, parseModelJson, toModelSchema } from "../model/schemas.js";
import type { Model } from "../model/types.js";

export interface HypothesizeOutcome { hypotheses: Hypothesis[]; valid: boolean; calls: number; usage: Usage; notes: string[] }

/** Drafts hypotheses from stored results. Two invalid answers end inconclusive rather than crashing (I10). */
export async function hypothesize(ctx: InvestigationContext, results: QueryResult[], model: Model): Promise<HypothesizeOutcome> {
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const notes: string[] = [];
  if (!results.some((r) => r.status === "Complete" && r.rows.length > 0)) {
    return { hypotheses: [], valid: true, calls: 0, usage, notes: ["no query rows to analyse"] };
  }
  const user = buildHypothesizePrompt(ctx, results);
  let calls = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    calls++;
    try {
      const res = await model.complete({
        purpose: "hypothesize",
        system: HYPOTHESIZE_SYSTEM,
        user,
        schema: toModelSchema(HypothesisOutputSchema),
        maxOutputTokens: 700,
      });
      usage.inputTokens += res.usage.inputTokens;
      usage.outputTokens += res.usage.outputTokens;
      const parsed = parseModelJson(res.text, HypothesisOutputSchema);
      if (parsed.ok) {
        const hypotheses = [...parsed.value.hypotheses].sort((a, b) => a.rank - b.rank);
        return { hypotheses, valid: true, calls, usage, notes };
      }
      notes.push(`hypothesize attempt ${attempt} invalid: ${parsed.error}`);
    } catch (e) {
      notes.push(`hypothesize attempt ${attempt} failed: ${(e as Error).message}`);
    }
  }
  notes.push("hypothesize output invalid twice; treating as inconclusive");
  return { hypotheses: [], valid: false, calls, usage, notes };
}
