import { describe, expect, it } from "vitest";
import { activeFault, numParam, parseFlag } from "../../src/chaos/flag.js";

const valid = { scenarioId: "s", fault: "timeout", params: { rate: 0.3 }, until: "2026-10-03T10:10:00.000Z" };

describe("flag", () => {
  it.each(["", "{}", "nope", JSON.stringify({ ...valid, fault: "meteor" }), JSON.stringify({ scenarioId: "s", fault: "timeout", params: {} })])(
    "parseFlag(%j) is null",
    (raw) => {
      expect(parseFlag(raw)).toBeNull();
    },
  );
  it("parses a valid flag", () => {
    expect(parseFlag(JSON.stringify(valid))?.fault).toBe("timeout");
    expect(parseFlag(null)).toBeNull();
  });
  it("activeFault expires exactly at until (I7)", () => {
    const f = parseFlag(JSON.stringify(valid))!;
    const until = Date.parse(valid.until);
    expect(activeFault(f, until)).toBeNull();
    expect(activeFault(f, until + 1)).toBeNull();
    expect(activeFault(f, until - 1)).toBe(f);
    expect(activeFault(null, 0)).toBeNull();
  });
  it("numParam falls back", () => {
    const f = parseFlag(JSON.stringify(valid))!;
    expect(numParam(f, "rate", 1)).toBe(0.3);
    expect(numParam(f, "missing", 7)).toBe(7);
  });
});
