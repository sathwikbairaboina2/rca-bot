import { describe, expect, it } from "vitest";
import { intBetween, mulberry32, pick } from "../../src/core/rng.js";

describe("rng", () => {
  it("is deterministic and in [0,1)", () => {
    const a = mulberry32(42), b = mulberry32(42);
    const xs = [a(), a(), a()];
    expect(xs).toEqual([b(), b(), b()]);
    for (const x of xs) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1); }
  });
  it("differs by seed", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
  it("pick and intBetween stay in range", () => {
    const r = mulberry32(7);
    for (let i = 0; i < 50; i++) expect(["a", "b", "c"]).toContain(pick(r, ["a", "b", "c"]));
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const v = intBetween(r, 5, 9);
      expect(v).toBeGreaterThanOrEqual(5); expect(v).toBeLessThanOrEqual(9);
      seen.add(v);
    }
    expect(seen.has(5)).toBe(true);
    expect(seen.has(9)).toBe(true);
  });
});
