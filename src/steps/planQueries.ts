import { validateSelection } from "../core/catalog.js";
import type { InvestigationContext, QuerySelection, Usage } from "../core/types.js";
import { buildPlanPrompt, PLAN_SYSTEM } from "../model/prompts.js";
import { parseModelJson, PlanOutputSchema, toModelSchema } from "../model/schemas.js";
import type { Model } from "../model/types.js";

export const DEFAULT_PLAN_TEMPLATES = ["errors_by_message", "status_by_version", "downstream_status", "timeouts", "cold_starts", "throttling_exceptions"] as const;

export interface PlanOutcome {
  selections: QuerySelection[];
  rejected: { selection: unknown; reason: string }[];
  usedFallback: boolean;
  calls: number;
  usage: Usage;
  notes: string[];
}

/** The model proposes catalog selections; every one is validated (I2) and the fallback plan covers model failure (I10). */
export async function planQueries(ctx: InvestigationContext, model: Model): Promise<PlanOutcome> {
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const notes: string[] = [];
  const selections: QuerySelection[] = [];
  const rejected: { selection: unknown; reason: string }[] = [];
  let calls = 0;
  let proposed: unknown[] | null = null;

  for (let attempt = 1; attempt <= 2 && proposed === null; attempt++) {
    calls++;
    try {
      const res = await model.complete({
        purpose: "plan",
        system: PLAN_SYSTEM,
        user: buildPlanPrompt(ctx),
        schema: toModelSchema(PlanOutputSchema),
        maxOutputTokens: 400,
      });
      usage.inputTokens += res.usage.inputTokens;
      usage.outputTokens += res.usage.outputTokens;
      const parsed = parseModelJson(res.text, PlanOutputSchema);
      if (parsed.ok) proposed = parsed.value.queries;
      else notes.push(`plan attempt ${attempt} invalid: ${parsed.error}`);
    } catch (e) {
      notes.push(`plan attempt ${attempt} invalid: ${(e as Error).message}`);
    }
  }

  const seen = new Set<string>();
  for (const q of proposed ?? []) {
    try {
      const sel = validateSelection(q, ctx.logGroups);
      const key = `${sel.templateId}|${[...sel.logGroups].sort().join(",")}|${sel.filterValue ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      selections.push(sel);
    } catch (e) {
      rejected.push({ selection: q, reason: (e as Error).message });
    }
  }

  if (selections.length === 0) {
    notes.push("used default plan");
    return {
      selections: DEFAULT_PLAN_TEMPLATES.map((templateId) => ({ templateId, logGroups: ctx.logGroups.slice(0, 5) })),
      rejected,
      usedFallback: true,
      calls,
      usage,
      notes,
    };
  }
  return { selections, rejected, usedFallback: false, calls, usage, notes };
}
