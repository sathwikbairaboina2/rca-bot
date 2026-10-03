import type { LogEvent } from "../../src/core/types.js";

export function jsonEvent(ts: number, logGroup: string, obj: Record<string, unknown>): LogEvent {
  return { timestamp: ts, logGroup, logStream: "s1", message: JSON.stringify(obj) };
}

export function textEvent(ts: number, logGroup: string, message: string): LogEvent {
  return { timestamp: ts, logGroup, logStream: "s1", message };
}

export function reportEvent(ts: number, logGroup: string, o: { duration: number; initDuration?: number }): LogEvent {
  const fields: Record<string, string | number> = { "@type": "REPORT", "@duration": o.duration };
  if (o.initDuration !== undefined) fields["@initDuration"] = o.initDuration;
  const init = o.initDuration !== undefined ? `\tInit Duration: ${o.initDuration} ms` : "";
  return {
    timestamp: ts,
    logGroup,
    logStream: "s1",
    message: `REPORT RequestId: r\tDuration: ${o.duration} ms${init}`,
    fields,
  };
}

import type { InvestigationContext } from "../../src/core/types.js";

const CTX_T = Date.UTC(2026, 9, 3, 10, 0);
export const ctx: InvestigationContext = {
  alarm: { alarmName: "orders-5xx-rate", service: "orders", state: "ALARM", timeMs: CTX_T, reason: "r", metricName: "5XXError" },
  service: "orders",
  window: { startMs: CTX_T - 30 * 60_000, endMs: CTX_T + 2 * 60_000 },
  logGroups: ["/aws/lambda/rca-demo-orders"],
  deploys: [],
  metrics: [{ name: "5XXError", unit: "Ratio", points: [{ tMs: CTX_T - 20 * 60_000, value: 0 }, { tMs: CTX_T - 60_000, value: 0.4 }] }],
};
