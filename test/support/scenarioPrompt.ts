import { parseAlarmStateChange } from "../../src/core/alarmEvent.js";
import { incidentWindow, planQuery } from "../../src/core/catalog.js";
import type { InvestigationContext, QueryResult } from "../../src/core/types.js";
import { buildHypothesizePrompt } from "../../src/model/prompts.js";
import { FixtureQueryRunner } from "../../src/ports/queryRunner.js";
import { DEFAULT_PLAN_TEMPLATES } from "../../src/steps/planQueries.js";
import type { SimulationResult } from "../../src/sim/simulate.js";

/** Runs the default plan against a simulation and returns the context, results and hypothesize prompt. */
export async function scenarioPrompt(sim: SimulationResult): Promise<{ ctx: InvestigationContext; results: QueryResult[]; user: string }> {
  const raw = sim.alarmEvents.find((e) => (e as { detail: { alarmName: string } }).detail.alarmName === sim.scenario.expectedAlarm);
  const alarm = parseAlarmStateChange(raw);
  const window = incidentWindow(alarm.timeMs);
  const ctx: InvestigationContext = {
    alarm, service: alarm.service, window, logGroups: sim.logGroups,
    deploys: sim.deploys, metrics: sim.metrics.map((m) => ({ ...m, points: m.points.filter((p) => p.tMs >= window.startMs && p.tMs <= window.endMs) })),
  };
  const runner = new FixtureQueryRunner(sim.logs);
  const results: QueryResult[] = [];
  for (const [i, templateId] of DEFAULT_PLAN_TEMPLATES.entries()) {
    results.push(await runner.run(planQuery(`q${i + 1}`, { templateId, logGroups: sim.logGroups }, window)));
  }
  return { ctx, results, user: buildHypothesizePrompt(ctx, results) };
}
