import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { revertExpired, SsmFlagStore, startScenario, stopScenario, type ChaosDeps } from "../chaos/chaos.js";
import { FAULTS } from "../chaos/flag.js";
import { CATEGORIES } from "../core/types.js";
import { ddbDoc, requireEnv, ssmClient } from "./env.js";

const ScenarioSchema = z.object({
  id: z.string(),
  fault: z.enum(FAULTS),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
  durationSec: z.number(),
  expectedCategory: z.enum(CATEGORIES),
  expectedAlarm: z.string(),
});

export const ChaosEventSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), scenario: ScenarioSchema }),
  z.object({ action: z.literal("stop") }),
  z.object({ action: z.literal("revert-expired") }),
]);

function realDeps(): ChaosDeps {
  return {
    flags: new SsmFlagStore(ssmClient()),
    paramName: requireEnv("FLAG_PARAM"),
    truth: {
      putTruth: async (t) => {
        await ddbDoc().send(new PutCommand({ TableName: requireEnv("TABLE_NAME"), Item: { pk: `TRUTH#${t.scenarioId}`, sk: "TRUTH", ...t } }));
      },
    },
  };
}

export async function handleChaosEvent(event: unknown, deps: ChaosDeps, nowMs: number): Promise<Record<string, unknown>> {
  const e = ChaosEventSchema.parse(event);
  if (e.action === "start") {
    const { flag } = await startScenario(e.scenario, { ...deps, nowMs });
    return { action: "start", flag };
  }
  if (e.action === "stop") {
    await stopScenario(deps);
    return { action: "stop" };
  }
  return { action: "revert-expired", ...(await revertExpired({ ...deps, nowMs })) };
}

export async function handler(event: unknown): Promise<Record<string, unknown>> {
  return handleChaosEvent(event, realDeps(), Date.now());
}
