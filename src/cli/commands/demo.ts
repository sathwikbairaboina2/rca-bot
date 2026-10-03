import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseAlarmStateChange } from "../../core/alarmEvent.js";
import { toIso } from "../../core/time.js";
import { createModel } from "../../model/factory.js";
import { SimContextSource } from "../../ports/contextSource.js";
import { MemoryIncidentStore } from "../../ports/incidentStore.js";
import { FixtureQueryRunner } from "../../ports/queryRunner.js";
import { MemoryResultsStore } from "../../ports/resultsStore.js";
import { choosePoster, type SlackPoster } from "../../ports/slack.js";
import { investigate } from "../../pipeline/investigate.js";
import { getScenario } from "../../sim/scenarios.js";
import { simulate } from "../../sim/simulate.js";
import { renderTerminal } from "../../slack/render.js";
import { newIncidentId } from "../../steps/dedupeBudget.js";
import type { CliIo } from "../io.js";

export async function demoCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { model: { type: "string" }, seed: { type: "string" }, json: { type: "boolean" } },
  });
  const id = positionals[0];
  if (!id) {
    io.stderr("usage: rca demo <scenarioId> [--model heuristic] [--seed 1001] [--json]");
    return 2;
  }
  let scenario;
  try {
    scenario = getScenario(id);
  } catch (e) {
    io.stderr((e as Error).message);
    return 2;
  }
  const seed = values.seed ? Number(values.seed) : 1001;
  if (!Number.isFinite(seed)) {
    io.stderr("--seed must be a number");
    return 2;
  }
  const modelSpec = values.model ?? io.env.RCA_MODEL ?? "heuristic";
  let model;
  try {
    model = createModel(modelSpec, io.env);
  } catch (e) {
    io.stderr((e as Error).message);
    return 2;
  }

  const sim = await simulate(scenario, { seed });
  const raw = sim.alarmEvents.find((e) => (e as { detail: { alarmName: string } }).detail.alarmName === scenario.expectedAlarm);
  if (!raw) {
    io.stderr(`the simulation did not raise ${scenario.expectedAlarm}`);
    return 1;
  }
  const alarm = parseAlarmStateChange(raw);
  const requests = (sim.metrics.find((m) => m.name === "Count")?.points ?? []).reduce((n, p) => n + p.value, 0);

  let location: string | null = null;
  const inner = await choosePoster({
    env: io.env, cwd: io.cwd, fetchImpl: io.fetch,
    ...(io.env.RCA_SINK_URL ? { sinkUrl: io.env.RCA_SINK_URL } : {}),
  });
  const poster: SlackPoster = {
    kind: inner.kind,
    post: async (msg, incidentId) => {
      const r = await inner.post(msg, incidentId);
      location = r.location;
      return r;
    },
  };

  const started = performance.now();
  const report = await investigate(raw, {
    store: new MemoryIncidentStore(),
    results: new MemoryResultsStore(),
    runner: new FixtureQueryRunner(sim.logs),
    model,
    poster,
    context: new SimContextSource(sim),
    now: () => alarm.timeMs,
    newId: () => newIncidentId(alarm.timeMs),
  });
  const tookMs = Math.round(performance.now() - started);

  const dir = join(io.cwd, ".rca", "incidents");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${report.incidentId}.json`), JSON.stringify(report, null, 2));

  if (values.json) {
    io.stdout(JSON.stringify(report, null, 2));
    return 0;
  }
  io.stdout(`Simulated ${scenario.id} (seed ${seed}): ${requests} requests, ${sim.logs.length} log events; fault ${scenario.fault} from ${toIso(sim.faultStartMs)}`);
  io.stdout(`Alarm ${alarm.alarmName} fired at ${toIso(alarm.timeMs)}`);
  io.stdout("");
  io.stdout(renderTerminal(report));
  io.stdout("");
  io.stdout(location ? `Card posted to ${location}` : "Card not posted (see notes above)");
  io.stdout(`Investigation took ${tookMs} ms`);
  return 0;
}
