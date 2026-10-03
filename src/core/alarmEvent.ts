import { z } from "zod";
import type { AlarmEvent } from "./types.js";
import { toIso } from "./time.js";

export function defaultServiceOf(name: string): string {
  const i = name.indexOf("-");
  return i < 0 ? name : name.slice(0, i);
}

export interface BuildAlarmArgs {
  alarmName: string;
  state: "ALARM" | "OK" | "INSUFFICIENT_DATA";
  timeMs: number;
  reason: string;
  metricNamespace: string;
  metricName: string;
  account?: string;
  region?: string;
}

/** The EventBridge "CloudWatch Alarm State Change" shape. */
export function buildAlarmStateChangeEvent(a: BuildAlarmArgs): Record<string, unknown> {
  const account = a.account ?? "000000000000";
  const region = a.region ?? "us-east-1";
  const iso = toIso(a.timeMs);
  return {
    version: "0",
    id: `evt-${a.timeMs}-${a.alarmName}`,
    "detail-type": "CloudWatch Alarm State Change",
    source: "aws.cloudwatch",
    account,
    time: iso,
    region,
    resources: [`arn:aws:cloudwatch:${region}:${account}:alarm:${a.alarmName}`],
    detail: {
      alarmName: a.alarmName,
      state: { value: a.state, reason: a.reason, timestamp: iso },
      previousState: { value: "OK", reason: "", timestamp: iso },
      configuration: {
        metrics: [
          {
            id: "m1",
            metricStat: { metric: { namespace: a.metricNamespace, name: a.metricName, dimensions: {} }, period: 60, stat: "Average" },
            returnData: true,
          },
        ],
      },
    },
  };
}

const AlarmEventSchema = z.object({
  source: z.literal("aws.cloudwatch"),
  "detail-type": z.literal("CloudWatch Alarm State Change"),
  time: z.string(),
  detail: z.object({
    alarmName: z.string().min(1),
    state: z.object({ value: z.enum(["ALARM", "OK", "INSUFFICIENT_DATA"]), reason: z.string().optional() }),
    configuration: z
      .object({ metrics: z.array(z.object({ metricStat: z.object({ metric: z.object({ name: z.string() }) }).optional() })).optional() })
      .optional(),
  }),
});

export function parseAlarmStateChange(event: unknown, serviceOf: (alarmName: string) => string = defaultServiceOf): AlarmEvent {
  const r = AlarmEventSchema.safeParse(event);
  if (!r.success) {
    throw new Error(`not a CloudWatch alarm state change event: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const e = r.data;
  const timeMs = Date.parse(e.time);
  if (!Number.isFinite(timeMs)) throw new Error(`invalid event time ${e.time}`);
  return {
    alarmName: e.detail.alarmName,
    service: serviceOf(e.detail.alarmName),
    state: e.detail.state.value,
    timeMs,
    reason: e.detail.state.reason ?? "",
    metricName: e.detail.configuration?.metrics?.[0]?.metricStat?.metric.name ?? "",
  };
}
