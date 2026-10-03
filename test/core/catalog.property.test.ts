import fc from "fast-check";
import { describe, it } from "vitest";
import { clampWindow, incidentWindow, MAX_WINDOW_MS } from "../../src/core/catalog.js";

describe("clampWindow (property)", () => {
  it("always lies inside the incident window and is at most 60 minutes", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4e12 }),
        fc.integer({ min: -1e9, max: 1e9 }),
        fc.integer({ min: -1e8, max: 1e9 }),
        (alarmMs, startOff, length) => {
          const incident = incidentWindow(alarmMs);
          const startMs = alarmMs + startOff;
          const out = clampWindow({ startMs, endMs: startMs + length }, incident);
          return (
            out.startMs >= incident.startMs && out.endMs <= incident.endMs && out.startMs <= out.endMs &&
            out.endMs - out.startMs <= MAX_WINDOW_MS
          );
        },
      ),
      { numRuns: 500 },
    );
  });
});
