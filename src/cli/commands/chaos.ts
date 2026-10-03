import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { SSMClient } from "@aws-sdk/client-ssm";
import { SsmFlagStore, startScenario, stopScenario, type TruthSink } from "../../chaos/chaos.js";
import { getScenario, loadScenarios } from "../../sim/scenarios.js";
import type { CliIo } from "../io.js";

export async function chaosCommand(args: string[], io: CliIo): Promise<number> {
  const sub = args[0];
  if (sub === "list") {
    io.stdout(["id".padEnd(22), "fault".padEnd(16), "expectedCategory".padEnd(24), "expectedAlarm".padEnd(20), "durationSec"].join(" "));
    for (const s of loadScenarios()) {
      io.stdout([s.id.padEnd(22), s.fault.padEnd(16), s.expectedCategory.padEnd(24), s.expectedAlarm.padEnd(20), String(s.durationSec)].join(" "));
    }
    return 0;
  }
  if (sub !== "start" && sub !== "stop") {
    io.stderr("usage: rca chaos list | start <scenarioId> | stop");
    return 2;
  }
  const { values, positionals } = parseArgs({
    args: args.slice(1),
    allowPositionals: true,
    options: { param: { type: "string" }, region: { type: "string" }, endpoint: { type: "string" } },
  });
  const paramName = values.param ?? "/rca-demo/chaos/active";
  const client = new SSMClient({
    region: values.region ?? io.env.AWS_REGION ?? "us-east-1",
    ...(values.endpoint ? { endpoint: values.endpoint } : {}),
  });
  const flags = new SsmFlagStore(client);
  try {
    if (sub === "stop") {
      await stopScenario({ flags, truth: { putTruth: async () => {} }, paramName });
      io.stdout(`Fault flag cleared on ${paramName}`);
      return 0;
    }
    const id = positionals[0];
    if (!id) {
      io.stderr("usage: rca chaos start <scenarioId>");
      return 2;
    }
    let scenario;
    try {
      scenario = getScenario(id);
    } catch (e) {
      io.stderr((e as Error).message);
      return 2;
    }
    const truth: TruthSink = {
      putTruth: async (t) => {
        const dir = join(io.cwd, ".rca", "truth");
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `${t.scenarioId}.json`), JSON.stringify(t, null, 2));
      },
    };
    const { flag } = await startScenario(scenario, { flags, truth, paramName, nowMs: io.now() });
    io.stdout(`Fault flag set on ${paramName}`);
    io.stdout(flag);
    return 0;
  } catch (e) {
    io.stderr(`chaos ${sub} failed: ${(e as Error).message}`);
    return 1;
  }
}
