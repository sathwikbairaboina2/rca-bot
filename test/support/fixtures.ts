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
