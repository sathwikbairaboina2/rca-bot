import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAlarmStateChange } from "../../src/core/alarmEvent.js";
import type { LogEvent } from "../../src/core/types.js";
import type { Model } from "../../src/model/types.js";
import { SimContextSource } from "../../src/ports/contextSource.js";
import { MemoryIncidentStore } from "../../src/ports/incidentStore.js";
import { FixtureQueryRunner } from "../../src/ports/queryRunner.js";
import { MemoryResultsStore } from "../../src/ports/resultsStore.js";
import { FilePoster, type SlackPoster } from "../../src/ports/slack.js";
import type { PipelineDeps } from "../../src/pipeline/investigate.js";
import { getScenario } from "../../src/sim/scenarios.js";
import { simulate, type SimulationResult } from "../../src/sim/simulate.js";

const sims = new Map<string, SimulationResult>();
export async function simFor(id: string, seed = 1001): Promise<SimulationResult> {
  const key = `${id}:${seed}`;
  let s = sims.get(key);
  if (!s) { s = await simulate(getScenario(id), { seed }); sims.set(key, s); }
  return s;
}

export function alarmEventOf(sim: SimulationResult, alarmName = sim.scenario.expectedAlarm): unknown {
  const e = sim.alarmEvents.find((x) => (x as { detail: { alarmName: string } }).detail.alarmName === alarmName);
  if (!e) throw new Error(`no ${alarmName} event`);
  return e;
}

export interface TestDeps {
  deps: PipelineDeps;
  store: MemoryIncidentStore;
  cardDir: string;
  clock: { now: number };
}

export function makeDeps(sim: SimulationResult, model: Model, o: { store?: MemoryIncidentStore; poster?: SlackPoster | null; extraLogs?: LogEvent[] } = {}): TestDeps {
  const store = o.store ?? new MemoryIncidentStore();
  const cardDir = mkdtempSync(join(tmpdir(), "rca-cards-"));
  const clock = { now: parseAlarmStateChange(alarmEventOf(sim)).timeMs };
  let n = 0;
  const deps: PipelineDeps = {
    store,
    results: new MemoryResultsStore(),
    runner: new FixtureQueryRunner([...sim.logs, ...(o.extraLogs ?? [])]),
    model,
    poster: o.poster === undefined ? new FilePoster(cardDir) : o.poster,
    context: new SimContextSource(sim),
    now: () => clock.now,
    newId: () => `inc-test-${++n}`,
  };
  return { deps, store, cardDir, clock };
}
