import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { verifyEvidence } from "../core/verifyEvidence.js";
import { FabricatorModel, type FabricationKind } from "../model/fabricator.js";
import { HeuristicModel } from "../model/heuristic.js";
import { loadScenarios } from "../sim/scenarios.js";
import { runPipelineOnScenario } from "./runEval.js";

export interface FabricationReport {
  schema: 1;
  env: "local-fixture";
  fabricatedInjected: number;
  fabricatedBlocked: number;
  byKind: Record<FabricationKind, { injected: number; blocked: number }>;
  honestInjected: number;
  honestKept: number;
  unverifiedPostedTotal: number;
  runs: { scenarioId: string; seed: number; injected: number; blocked: number; honestKept: boolean }[];
}

/** Injects fabricated citations (one wrong character, wrong row, unknown query, extra field) and checks every one is blocked. */
export async function runFabricationBench(o: { repeat: number; outFile: string }): Promise<FabricationReport> {
  const byKind: FabricationReport["byKind"] = {
    char: { injected: 0, blocked: 0 }, row: { injected: 0, blocked: 0 }, query: { injected: 0, blocked: 0 }, field: { injected: 0, blocked: 0 },
  };
  const out: FabricationReport = {
    schema: 1, env: "local-fixture", fabricatedInjected: 0, fabricatedBlocked: 0, byKind,
    honestInjected: 0, honestKept: 0, unverifiedPostedTotal: 0, runs: [],
  };
  for (let r = 0; r < o.repeat; r++) {
    for (const s of loadScenarios()) {
      const seed = 1000 + r;
      const model = new FabricatorModel(new HeuristicModel(), { seed });
      const { report } = await runPipelineOnScenario(s, seed, model);
      const droppedSummaries = new Set(report.dropped.map((d) => d.hypothesis.summary));
      const postedSummaries = new Set(report.posted.map((h) => h.summary));
      let blocked = 0;
      for (const f of model.log.fabricated) {
        byKind[f.kind].injected++;
        if (droppedSummaries.has(f.summary) && !postedSummaries.has(f.summary)) {
          byKind[f.kind].blocked++;
          blocked++;
        }
      }
      const kept = model.log.honest.filter((h) => postedSummaries.has(h)).length;
      out.fabricatedInjected += model.log.fabricated.length;
      out.fabricatedBlocked += blocked;
      out.honestInjected += model.log.honest.length;
      out.honestKept += kept;
      out.unverifiedPostedTotal += verifyEvidence(report.posted, report.queries).dropped.length;
      out.runs.push({ scenarioId: s.id, seed, injected: model.log.fabricated.length, blocked, honestKept: kept === model.log.honest.length });
    }
  }
  await mkdir(dirname(o.outFile), { recursive: true });
  await writeFile(o.outFile, JSON.stringify(out, null, 2));
  return out;
}
