import { ListTagsForResourceCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import { describe, expect, it } from "vitest";
import {
  ChaosTargetError, revertExpired, SsmFlagStore, startScenario, stopScenario, type FlagStore, type ScenarioDef,
} from "../../src/chaos/chaos.js";

const NAME = "/rca-demo/chaos/active";
const scenario: ScenarioDef = {
  id: "ddb-throttle-40", fault: "ddb_throttle", params: { rate: 0.4 }, durationSec: 600, expectedCategory: "DEPENDENCY_THROTTLING", expectedAlarm: "orders-5xx-rate",
};
const NOW = Date.UTC(2026, 9, 3, 10, 0);

function fakes(tags: Record<string, string>) {
  const values = new Map<string, string>();
  const truths: unknown[] = [];
  const flags: FlagStore = {
    getTags: async () => tags,
    put: async (n, v) => { values.set(n, v); },
    get: async (n) => values.get(n) ?? null,
  };
  return { values, truths, deps: { flags, truth: { putTruth: async (t: unknown) => { truths.push(t); } }, paramName: NAME } };
}

describe("chaos", () => {
  it("start writes the flag and the truth record", async () => {
    const f = fakes({ "chaos:allowed": "true" });
    await startScenario(scenario, { ...f.deps, nowMs: NOW });
    const flag = JSON.parse(f.values.get(NAME)!);
    expect(flag.until).toBe(new Date(NOW + 600_000).toISOString());
    expect(flag.fault).toBe("ddb_throttle");
    expect(f.truths[0]).toMatchObject({ scenarioId: "ddb-throttle-40", category: "DEPENDENCY_THROTTLING", startedAtMs: NOW });
  });
  it("refuses an untagged target and writes nothing (I8)", async () => {
    const f = fakes({});
    await expect(startScenario(scenario, { ...f.deps, nowMs: NOW })).rejects.toBeInstanceOf(ChaosTargetError);
    expect(f.values.size).toBe(0);
    expect(f.truths).toHaveLength(0);
  });
  it("refuses over-long and non-positive durations", async () => {
    const f = fakes({ "chaos:allowed": "true" });
    await expect(startScenario({ ...scenario, durationSec: 1801 }, { ...f.deps, nowMs: NOW })).rejects.toThrow();
    await expect(startScenario({ ...scenario, durationSec: 0 }, { ...f.deps, nowMs: NOW })).rejects.toThrow();
  });
  it("stop writes {}", async () => {
    const f = fakes({ "chaos:allowed": "true" });
    await stopScenario(f.deps);
    expect(f.values.get(NAME)).toBe("{}");
  });
  it("revertExpired only clears an expired flag (I7)", async () => {
    const f = fakes({ "chaos:allowed": "true" });
    await startScenario(scenario, { ...f.deps, nowMs: NOW });
    expect(await revertExpired({ ...f.deps, nowMs: NOW + 599_000 })).toEqual({ reverted: false });
    expect(f.values.get(NAME)).not.toBe("{}");
    expect(await revertExpired({ ...f.deps, nowMs: NOW + 600_000 })).toEqual({ reverted: true });
    expect(f.values.get(NAME)).toBe("{}");
    expect(await revertExpired({ ...f.deps, nowMs: NOW + 700_000 })).toEqual({ reverted: false });
  });
});

describe("SsmFlagStore", () => {
  it("lists tags with ResourceType Parameter and overwrites on put", async () => {
    const ssm = mockClient(SSMClient);
    ssm.on(ListTagsForResourceCommand).resolves({ TagList: [{ Key: "chaos:allowed", Value: "true" }] });
    ssm.on(PutParameterCommand).resolves({});
    const store = new SsmFlagStore(ssm as unknown as SSMClient);
    expect(await store.getTags(NAME)).toEqual({ "chaos:allowed": "true" });
    await store.put(NAME, "{}");
    expect(ssm.commandCalls(ListTagsForResourceCommand)[0]!.args[0].input).toMatchObject({ ResourceType: "Parameter", ResourceId: NAME });
    expect(ssm.commandCalls(PutParameterCommand)[0]!.args[0].input).toMatchObject({ Overwrite: true, Type: "String", Name: NAME, Value: "{}" });
    ssm.restore();
  });
});
