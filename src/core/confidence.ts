import type { Confidence, Evidence } from "./types.js";

/** I9: bands come from how much independent evidence backs a hypothesis, never from the model. */
export function computeConfidence(evidence: Evidence[]): Confidence {
  const refs = evidence.length;
  const queries = new Set(evidence.map((e) => e.queryId)).size;
  if (refs >= 3 && queries >= 2) return "High";
  if (refs >= 2 || queries >= 2) return "Medium";
  return "Low";
}
