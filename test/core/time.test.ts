import { describe, expect, it } from "vitest";
import { formatInsightsTimestamp, minuteFloor, toIso } from "../../src/core/time.js";

describe("time", () => {
  it("formats insights timestamps", () => {
    expect(formatInsightsTimestamp(Date.UTC(2026, 9, 3, 10, 0, 5, 7))).toBe("2026-10-03 10:00:05.007");
  });
  it("floors to the minute", () => {
    expect(minuteFloor(Date.UTC(2026, 9, 3, 10, 0, 59, 999))).toBe(Date.UTC(2026, 9, 3, 10, 0, 0, 0));
  });
  it("toIso", () => {
    expect(toIso(0)).toBe(new Date(0).toISOString());
  });
});
