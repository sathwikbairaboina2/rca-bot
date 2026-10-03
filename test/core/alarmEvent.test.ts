import { describe, expect, it } from "vitest";
import { buildAlarmStateChangeEvent, defaultServiceOf, parseAlarmStateChange } from "../../src/core/alarmEvent.js";

const T = Date.UTC(2026, 9, 3, 10, 0);
const build = () =>
  buildAlarmStateChangeEvent({
    alarmName: "orders-5xx-rate", state: "ALARM", timeMs: T, reason: "Threshold Crossed", metricNamespace: "AWS/ApiGateway", metricName: "5XXError",
  });

describe("alarm events", () => {
  it("round-trips build and parse", () => {
    expect(parseAlarmStateChange(build())).toEqual({
      alarmName: "orders-5xx-rate", service: "orders", state: "ALARM", timeMs: T, reason: "Threshold Crossed", metricName: "5XXError",
    });
  });
  it("rejects a wrong source", () => {
    expect(() => parseAlarmStateChange({ ...build(), source: "aws.ec2" })).toThrow(/alarm state change/);
  });
  it("rejects a missing alarmName", () => {
    const e = build() as { detail: Record<string, unknown> };
    delete e.detail.alarmName;
    expect(() => parseAlarmStateChange(e)).toThrow();
  });
  it("allows overriding serviceOf", () => {
    expect(parseAlarmStateChange(build(), () => "svc").service).toBe("svc");
    expect(defaultServiceOf("orders-5xx-rate")).toBe("orders");
  });
});
