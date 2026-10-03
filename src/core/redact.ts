import type { Row } from "./types.js";

export const PROMPT_LIMITS = { rowsPerQuery: 10, cellChars: 200 } as const;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;

/** I12: PII is replaced before any text reaches a model. */
export function redactText(s: string): string {
  return s.replace(EMAIL_RE, "[email]").replace(CARD_RE, "[card]");
}

export function prepareRowsForPrompt(rows: Row[]): { rows: Row[]; omitted: number } {
  const kept = rows.slice(0, PROMPT_LIMITS.rowsPerQuery).map((r) => {
    const out: Row = {};
    for (const [k, v] of Object.entries(r)) {
      const red = redactText(v);
      out[k] = red.length > PROMPT_LIMITS.cellChars ? red.slice(0, PROMPT_LIMITS.cellChars) + "…[truncated]" : red;
    }
    return out;
  });
  return { rows: kept, omitted: Math.max(0, rows.length - kept.length) };
}
