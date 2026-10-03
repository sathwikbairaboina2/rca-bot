import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseAlarmStateChange } from "../core/alarmEvent.js";
import type { Category, IncidentReport, IncidentStatus } from "../core/types.js";
import type { ScenarioDef } from "../chaos/chaos.js";
import { createModel } from "../model/factory.js";
import type { Model } from "../model/types.js";
import { SimContextSource } from "../ports/contextSource.js";
import { MemoryIncidentStore } from "../ports/incidentStore.js";
import { FixtureQueryRunner } from "../ports/queryRunner.js";
import { MemoryResultsStore } from "../ports/resultsStore.js";
import { investigate } from "../pipeline/investigate.js";
import { loadScenarios } from "../sim/scenarios.js";
import { simulate, type SimulationResult } from "../sim/simulate.js";
import { newIncidentId } from "../steps/dedupeBudget.js";
import { scoreRun } from "./score.js";

export interface EvalOptions {
  modelSpec: string;
  scenarioIds: string[] | "all";
  repeat: number;
  outFile: string;
  model?: Model;
  onRun?: (r: EvalRun, i: number, total: number) => void;
  env?: NodeJS.ProcessEnv;
}

export interface EvalRun {
  scenarioId: string;
  seed: number;
  expected: Category;
  status: IncidentStatus | "ERROR";
  postedCategories: Category[];
  top1: boolean;
  top2: boolean;
  inconclusive: boolean;
  unverifiedPosted: number;
  dropped: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  queriesRun: number;
  ms: number;
  notes: string[];
  error?: string;
}

export interface EvalSummary {
  n: number;
  top1Rate: number;
  top2Rate: number;
  inconclusiveRate: number;
  unverifiedPostedTotal: number;
  droppedTotal: number;
  errorCount: number;
  medianMs: number;
  p95Ms: number;
  inputTokens: number;
  outputTokens: number;
  perScenario: Record<string, { n: number; top1: number; top2: number; inconclusive: number }>;
}

export interface EvalReport {
  schema: 1;
  env: "local-fixture";
  model: string;
  startedAt: string;
  updatedAt: string;
  complete: boolean;
  runsPlanned: number;
  runs: EvalRun[];
  summary: EvalSummary;
}

const r4 = (n: number) => Number(n.toFixed(4));

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

export function summarize(runs: EvalRun[]): EvalSummary {
  const n = runs.length;
  const rate = (k: number) => (n === 0 ? 0 : r4(k / n));
  const ms = runs.map((r) => r.ms).sort((a, b) => a - b);
  const perScenario: EvalSummary["perScenario"] = {};
  for (const r of runs) {
    const p = (perScenario[r.scenarioId] ??= { n: 0, top1: 0, top2: 0, inconclusive: 0 });
    p.n++;
    if (r.top1) p.top1++;
    if (r.top2) p.top2++;
    if (r.inconclusive) p.inconclusive++;
  }
  return {
    n,
    top1Rate: rate(runs.filter((r) => r.top1).length),
    top2Rate: rate(runs.filter((r) => r.top2).length),
    inconclusiveRate: rate(runs.filter((r) => r.inconclusive).length),
    unverifiedPostedTotal: runs.reduce((a, r) => a + r.unverifiedPosted, 0),
    droppedTotal: runs.reduce((a, r) => a + r.dropped, 0),
    errorCount: runs.filter((r) => r.status === "ERROR").length,
    medianMs: percentile(ms, 0.5),
    p95Ms: percentile(ms, 0.95),
    inputTokens: runs.reduce((a, r) => a + r.inputTokens, 0),
    outputTokens: runs.reduce((a, r) => a + r.outputTokens, 0),
    perScenario,
  };
}

/** Simulates one scenario and runs the full pipeline on its expected alarm with fresh in-memory stores and no Slack. */
export async function runPipelineOnScenario(
  scenario: ScenarioDef, seed: number, model: Model,
): Promise<{ report: IncidentReport; sim: SimulationResult; ms: number }> {
  const sim = await simulate(scenario, { seed });
  const raw = sim.alarmEvents.find((e) => (e as { detail: { alarmName: string } }).detail.alarmName === scenario.expectedAlarm);
  if (!raw) throw new Error(`simulation of ${scenario.id} (seed ${seed}) did not raise ${scenario.expectedAlarm}`);
  const alarm = parseAlarmStateChange(raw);
  const started = performance.now();
  const report = await investigate(raw, {
    store: new MemoryIncidentStore(),
    results: new MemoryResultsStore(),
    runner: new FixtureQueryRunner(sim.logs),
    model,
    poster: null,
    context: new SimContextSource(sim),
    now: () => alarm.timeMs,
    newId: () => newIncidentId(alarm.timeMs, () => (seed % 997) / 997),
  });
  return { report, sim, ms: Math.round(performance.now() - started) };
}

export function selectScenarios(ids: string[] | "all"): ScenarioDef[] {
  const all = loadScenarios();
  if (ids === "all") return all;
  return ids.map((id) => {
    const s = all.find((x) => x.id === id);
    if (!s) throw new Error(`unknown scenario ${id}; try: ${all.map((x) => x.id).join(", ")}`);
    return s;
  });
}

export async function runEval(o: EvalOptions): Promise<EvalReport> {
  const scenarios = selectScenarios(o.scenarioIds);
  const model = o.model ?? createModel(o.modelSpec, o.env ?? process.env);
  const total = scenarios.length * o.repeat;
  const startedAt = new Date().toISOString();
  const runs: EvalRun[] = [];

  const write = async (complete: boolean): Promise<EvalReport> => {
    const report: EvalReport = {
      schema: 1, env: "local-fixture", model: model.id, startedAt, updatedAt: new Date().toISOString(),
      complete, runsPlanned: total, runs, summary: summarize(runs),
    };
    await mkdir(dirname(o.outFile), { recursive: true });
    await writeFile(o.outFile, JSON.stringify(report, null, 2));
    return report;
  };

  let i = 0;
  for (let r = 0; r < o.repeat; r++) {
    for (const s of scenarios) {
      const seed = 1000 + r;
      let run: EvalRun;
      try {
        const { report, sim, ms } = await runPipelineOnScenario(s, seed, model);
        const sc = scoreRun(report, sim.truth);
        run = {
          scenarioId: s.id, seed, expected: s.expectedCategory, status: report.status,
          postedCategories: report.posted.map((h) => h.category), ...sc, dropped: report.dropped.length,
          modelCalls: report.modelCalls, inputTokens: report.usage.inputTokens, outputTokens: report.usage.outputTokens,
          queriesRun: report.queries.length, ms, notes: report.notes,
        };
      } catch (e) {
        run = {
          scenarioId: s.id, seed, expected: s.expectedCategory, status: "ERROR", postedCategories: [], top1: false, top2: false,
          inconclusive: false, unverifiedPosted: 0, dropped: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, queriesRun: 0,
          ms: 0, notes: [], error: (e as Error).message,
        };
      }
      runs.push(run);
      i++;
      o.onRun?.(run, i, total);
      await write(i === total);
    }
  }
  return write(true);
}
