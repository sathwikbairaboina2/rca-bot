import { describe, expect, it } from "vitest";
import { computeConfidence } from "../../src/core/confidence.js";
import type { Evidence } from "../../src/core/types.js";

const refs = (...qs: string[]): Evidence[] => qs.map((queryId, row) => ({ queryId, row, quote: { f: "v" } }));

describe("computeConfidence", () => {
  it.each([
    [refs("q1"), "Low"],
    [refs("q1", "q1"), "Medium"],
    [refs("q1", "q2"), "Medium"],
    [refs("q1", "q1", "q1"), "Medium"],
    [refs("q1", "q1", "q2"), "High"],
    [refs("q1", "q2", "q3", "q1", "q2"), "High"],
  ])("%#", (e, band) => {
    expect(computeConfidence(e)).toBe(band);
  });
});
