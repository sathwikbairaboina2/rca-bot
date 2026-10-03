import { GetParameterCommand, ListTagsForResourceCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { toIso } from "../core/time.js";
import type { Category, GroundTruth } from "../core/types.js";
import { parseFlag, type Fault } from "./flag.js";

export const MAX_DURATION_SEC = 1800;

export interface ScenarioDef {
  id: string;
  fault: Fault;
  params: Record<string, string | number>;
  durationSec: number;
  expectedCategory: Category;
  expectedAlarm: string;
}

export class ChaosTargetError extends Error {
  constructor(message: string) { super(message); this.name = "ChaosTargetError"; }
}

export interface FlagStore {
  getTags(name: string): Promise<Record<string, string>>;
  put(name: string, value: string): Promise<void>;
  get(name: string): Promise<string | null>;
}
export interface TruthSink {
  putTruth(t: GroundTruth & { startedAtMs: number }): Promise<void>;
}
export interface ChaosDeps { flags: FlagStore; truth: TruthSink; paramName: string }

export async function startScenario(s: ScenarioDef, deps: ChaosDeps & { nowMs: number }): Promise<{ flag: string }> {
  if (!(s.durationSec > 0) || s.durationSec > MAX_DURATION_SEC) {
    throw new Error(`durationSec must be in (0, ${MAX_DURATION_SEC}]`);
  }
  const tags = await deps.flags.getTags(deps.paramName);
  if (tags["chaos:allowed"] !== "true") {
    throw new ChaosTargetError(`parameter ${deps.paramName} is not tagged chaos:allowed=true`);
  }
  const flag = JSON.stringify({ scenarioId: s.id, fault: s.fault, params: s.params, until: toIso(deps.nowMs + s.durationSec * 1000) });
  await deps.flags.put(deps.paramName, flag);
  await deps.truth.putTruth({ scenarioId: s.id, fault: s.fault, category: s.expectedCategory, startedAtMs: deps.nowMs });
  return { flag };
}

export async function stopScenario(deps: ChaosDeps): Promise<void> {
  await deps.flags.put(deps.paramName, "{}");
}

/** I7: the scheduled backstop. Clears the flag only when it is present and already expired. */
export async function revertExpired(deps: ChaosDeps & { nowMs: number }): Promise<{ reverted: boolean }> {
  const raw = await deps.flags.get(deps.paramName);
  const flag = parseFlag(raw);
  if (!flag) return { reverted: false };
  const until = Date.parse(flag.until);
  if (Number.isFinite(until) && until > deps.nowMs) return { reverted: false };
  await deps.flags.put(deps.paramName, "{}");
  return { reverted: true };
}

export class SsmFlagStore implements FlagStore {
  constructor(private readonly client: SSMClient = new SSMClient({})) {}

  async getTags(name: string): Promise<Record<string, string>> {
    const r = await this.client.send(new ListTagsForResourceCommand({ ResourceType: "Parameter", ResourceId: name }));
    const out: Record<string, string> = {};
    for (const t of r.TagList ?? []) if (t.Key) out[t.Key] = t.Value ?? "";
    return out;
  }

  async put(name: string, value: string): Promise<void> {
    await this.client.send(new PutParameterCommand({ Name: name, Value: value, Type: "String", Overwrite: true }));
  }

  async get(name: string): Promise<string | null> {
    try {
      const r = await this.client.send(new GetParameterCommand({ Name: name }));
      return r.Parameter?.Value ?? null;
    } catch (e) {
      if ((e as { name?: string }).name === "ParameterNotFound") return null;
      throw e;
    }
  }
}
