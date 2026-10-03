import { computeConfidence } from "./confidence.js";
import { isCategory, type DroppedHypothesis, type Evidence, type Hypothesis, type QueryResult, type VerifiedHypothesis } from "./types.js";

export interface Verdict { verified: VerifiedHypothesis[]; dropped: DroppedHypothesis[] }

/** Returns null when the citation is verbatim in the stored result, else the reason it is not. */
export function checkEvidence(ev: Evidence, byId: Map<string, QueryResult>): string | null {
  const q = byId.get(ev.queryId);
  if (!q) return `unknown queryId ${ev.queryId}`;
  if (q.status !== "Complete") return `query ${ev.queryId} did not complete (${q.status})`;
  if (!Number.isInteger(ev.row) || ev.row < 0 || ev.row >= q.rows.length) return `row ${ev.row} out of range for ${ev.queryId}`;
  const keys = Object.keys(ev.quote ?? {});
  if (keys.length === 0) return `empty quote for ${ev.queryId} row ${ev.row}`;
  const row = q.rows[ev.row]!;
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(row, k)) return `field ${k} not in ${ev.queryId} row ${ev.row}`;
    const v = ev.quote[k];
    if (typeof v !== "string" && typeof v !== "number") return `non-scalar quote for ${k}`;
    if (String(v) !== row[k]) return `value mismatch for ${k} in ${ev.queryId} row ${ev.row}`;
  }
  return null;
}

/** I1: a hypothesis survives only if every one of its citations is verbatim in the stored results. */
export function verifyEvidence(hypotheses: readonly Hypothesis[], results: readonly QueryResult[]): Verdict {
  const byId = new Map(results.map((r) => [r.queryId, r]));
  const verified: VerifiedHypothesis[] = [];
  const dropped: DroppedHypothesis[] = [];
  for (const h of hypotheses) {
    let reason: string | null = null;
    if (!isCategory(h.category)) reason = `unknown category ${String(h.category)}`;
    else if (h.category === "UNKNOWN") reason = "UNKNOWN is not a root cause";
    else if (!Array.isArray(h.evidence) || h.evidence.length === 0) reason = "no evidence";
    else for (const ev of h.evidence) { reason = checkEvidence(ev, byId); if (reason) break; }
    if (reason || !isCategory(h.category)) { dropped.push({ hypothesis: h, reason: reason ?? "invalid" }); continue; }
    verified.push({ rank: verified.length + 1, category: h.category, summary: h.summary, evidence: h.evidence, confidence: computeConfidence(h.evidence) });
  }
  return { verified, dropped };
}
