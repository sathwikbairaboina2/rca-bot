import { z } from "zod";
import { CATALOG } from "../core/catalog.js";
import { CATEGORIES } from "../core/types.js";

const templateIds = CATALOG.map((t) => t.id) as [string, ...string[]];

export const PlanOutputSchema = z
  .object({
    queries: z
      .array(
        z
          .object({
            templateId: z.enum(templateIds),
            logGroups: z.array(z.string()).min(1).max(5),
            filterValue: z.string().max(80).optional(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

export const HypothesisOutputSchema = z
  .object({
    hypotheses: z
      .array(
        z
          .object({
            rank: z.number().int().min(1).max(10),
            category: z.enum(CATEGORIES),
            summary: z.string().min(1).max(300),
            evidence: z
              .array(
                z
                  .object({
                    queryId: z.string().regex(/^q\d{1,2}$/),
                    row: z.number().int().min(0),
                    quote: z.record(z.string(), z.union([z.string(), z.number()])),
                  })
                  .strict(),
              )
              .min(1)
              .max(4),
          })
          .strict(),
      )
      .max(3),
  })
  .strict();

export type PlanOutput = z.infer<typeof PlanOutputSchema>;
export type HypothesisOutput = z.infer<typeof HypothesisOutputSchema>;

/** JSON Schema for Ollama `format` / Bedrock tool inputSchema (drops the $schema key). */
export function toModelSchema(s: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(s) as Record<string, unknown>;
  return rest;
}

/** Parse model text as JSON and validate. The only leniency is stripping one Markdown code fence. */
export function parseModelJson<T>(text: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; error: string } {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let json: unknown;
  try {
    json = JSON.parse(stripped);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}`.slice(0, 160) };
  }
  const r = schema.safeParse(json);
  if (!r.success) {
    const i = r.error.issues[0];
    return { ok: false, error: `schema: ${i ? `${i.path.join(".")}: ${i.message}` : "invalid"}`.slice(0, 160) };
  }
  return { ok: true, value: r.data };
}
