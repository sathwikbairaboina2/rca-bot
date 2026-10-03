import type { GroundTruth, IncidentReport } from "../core/types.js";
import { verifyEvidence } from "../core/verifyEvidence.js";

export interface Score { top1: boolean; top2: boolean; inconclusive: boolean; unverifiedPosted: number }

/**
 * `unverifiedPosted` re-verifies what was actually posted against the stored query results,
 * independently of the pipeline's own verdict.
 */
export function scoreRun(report: IncidentReport, truth: GroundTruth): Score {
  const cats = report.posted.map((h) => h.category);
  return {
    top1: cats[0] === truth.category,
    top2: cats.slice(0, 2).includes(truth.category),
    inconclusive: report.posted.length === 0,
    unverifiedPosted: verifyEvidence(report.posted, report.queries).dropped.length,
  };
}
