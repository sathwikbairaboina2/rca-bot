import { CloudWatchClient, DescribeAlarmsCommand, GetMetricDataCommand, type MetricDataQuery } from "@aws-sdk/client-cloudwatch";
import { incidentWindow } from "../core/catalog.js";
import type { AlarmEvent, InvestigationContext, MetricSeries } from "../core/types.js";
import type { SimulationResult } from "../sim/simulate.js";

export interface ContextSource { gather(alarm: AlarmEvent): Promise<InvestigationContext> }

export class SimContextSource implements ContextSource {
  constructor(private readonly sim: SimulationResult) {}

  async gather(alarm: AlarmEvent): Promise<InvestigationContext> {
    const window = incidentWindow(alarm.timeMs);
    return {
      alarm,
      service: alarm.service,
      window,
      logGroups: this.sim.logGroups,
      deploys: this.sim.deploys.filter((d) => d.atMs >= window.startMs - 60 * 60_000 && d.atMs <= window.endMs),
      metrics: this.sim.metrics.map((m) => ({ ...m, points: m.points.filter((p) => p.tMs >= window.startMs && p.tMs <= window.endMs) })),
    };
  }
}

export class CloudWatchContextSource implements ContextSource {
  constructor(private readonly opts: { cloudwatch: CloudWatchClient; logGroupsByService: Record<string, string[]> }) {}

  async gather(alarm: AlarmEvent): Promise<InvestigationContext> {
    const logGroups = this.opts.logGroupsByService[alarm.service];
    if (!logGroups) throw new Error(`no log groups configured for service ${alarm.service}`);
    const window = incidentWindow(alarm.timeMs);

    const described = await this.opts.cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: [alarm.alarmName] }));
    const a = described.MetricAlarms?.[0];
    let queries: MetricDataQuery[] = [];
    if (a?.Metrics?.length) {
      // Metric-math alarms: keep the alarm's own queries but force a 1-minute period on metric stats.
      queries = a.Metrics.map((m) => (m.MetricStat ? { ...m, MetricStat: { ...m.MetricStat, Period: 60 } } : m));
    } else if (a?.MetricName) {
      queries = [
        {
          Id: "m1",
          Label: a.MetricName,
          ReturnData: true,
          MetricStat: {
            Metric: { Namespace: a.Namespace, MetricName: a.MetricName, Dimensions: a.Dimensions },
            Period: 60,
            Stat: a.ExtendedStatistic ?? a.Statistic ?? "Average",
          },
        },
      ];
    }
    let metrics: MetricSeries[] = [];
    if (queries.length > 0) {
      const data = await this.opts.cloudwatch.send(
        new GetMetricDataCommand({ MetricDataQueries: queries, StartTime: new Date(window.startMs), EndTime: new Date(window.endMs) }),
      );
      metrics = (data.MetricDataResults ?? []).map((r) => ({
        name: r.Label ?? r.Id ?? "metric",
        unit: "",
        points: (r.Timestamps ?? []).map((t, i) => ({ tMs: t.getTime(), value: r.Values?.[i] ?? 0 })),
      }));
    }
    // v0.1 has no deploy timeline from AWS (CloudTrail/CodeDeploy); that is a v0.2 item, see the spec.
    return { alarm, service: alarm.service, window, logGroups, deploys: [], metrics };
  }
}
