import { CloudWatchClient, DescribeAlarmsCommand, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, it } from "vitest";
import { parseAlarmStateChange } from "../../src/core/alarmEvent.js";
import { CloudWatchContextSource, SimContextSource } from "../../src/ports/contextSource.js";
import { alarmEventOf, simFor } from "../support/pipelineDeps.js";

describe("SimContextSource", () => {
  it("restricts metrics to the window and keeps the red-herring deploy", async () => {
    const sim = await simFor("bad-deploy-v18");
    const alarm = parseAlarmStateChange(alarmEventOf(sim));
    const ctx = await new SimContextSource(sim).gather(alarm);
    expect(ctx.window.endMs - ctx.window.startMs).toBe(32 * 60_000);
    for (const m of ctx.metrics) for (const p of m.points) {
      expect(p.tMs).toBeGreaterThanOrEqual(ctx.window.startMs);
      expect(p.tMs).toBeLessThanOrEqual(ctx.window.endMs);
    }
    expect(ctx.deploys.map((d) => d.functionName)).toEqual(expect.arrayContaining(["rca-demo-payments", "rca-demo-orders"]));
    expect(ctx.logGroups).toEqual(sim.logGroups);
  });
});

describe("CloudWatchContextSource", () => {
  const cw = mockClient(CloudWatchClient);
  afterEach(() => cw.reset());
  const alarm = { alarmName: "orders-5xx-rate", service: "orders", state: "ALARM" as const, timeMs: Date.UTC(2026, 9, 3, 10, 0), reason: "r", metricName: "5XXError" };

  it("describes the alarm then reads its metric with a 60 s period", async () => {
    cw.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [{ AlarmName: "orders-5xx-rate", Namespace: "AWS/ApiGateway", MetricName: "5XXError", Statistic: "Average", Dimensions: [{ Name: "ApiName", Value: "x" }] }] });
    cw.on(GetMetricDataCommand).resolves({ MetricDataResults: [{ Id: "m1", Label: "5XXError", Timestamps: [new Date(1000), new Date(61000)], Values: [0.1, 0.2] }] });
    const ctx = await new CloudWatchContextSource({ cloudwatch: new CloudWatchClient({}), logGroupsByService: { orders: ["/aws/lambda/a"] } }).gather(alarm);
    const get = cw.commandCalls(GetMetricDataCommand)[0]!.args[0].input;
    expect(get.MetricDataQueries![0]!.MetricStat!.Period).toBe(60);
    expect(ctx.metrics[0]).toEqual({ name: "5XXError", unit: "", points: [{ tMs: 1000, value: 0.1 }, { tMs: 61000, value: 0.2 }] });
    expect(ctx.logGroups).toEqual(["/aws/lambda/a"]);
    expect(ctx.deploys).toEqual([]);
  });
  it("supports metric-math alarms", async () => {
    cw.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [{ AlarmName: "x", Metrics: [{ Id: "e1", Expression: "m1*2", ReturnData: true }, { Id: "m1", ReturnData: false, MetricStat: { Metric: { Namespace: "N", MetricName: "M" }, Period: 300, Stat: "Sum" } }] }] });
    cw.on(GetMetricDataCommand).resolves({ MetricDataResults: [] });
    await new CloudWatchContextSource({ cloudwatch: new CloudWatchClient({}), logGroupsByService: { orders: ["g"] } }).gather(alarm);
    const q = cw.commandCalls(GetMetricDataCommand)[0]!.args[0].input.MetricDataQueries!;
    expect(q).toHaveLength(2);
    expect(q[1]!.MetricStat!.Period).toBe(60);
  });
  it("throws for an unconfigured service", async () => {
    await expect(new CloudWatchContextSource({ cloudwatch: new CloudWatchClient({}), logGroupsByService: {} }).gather(alarm)).rejects.toThrow(/no log groups configured for service orders/);
  });
});
