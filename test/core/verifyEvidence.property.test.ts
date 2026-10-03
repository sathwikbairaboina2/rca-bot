import fc from "fast-check";
import { describe, it } from "vitest";
import { verifyEvidence } from "../../src/core/verifyEvidence.js";
import type { Hypothesis, QueryResult } from "../../src/core/types.js";

const printable = fc.string({ unit: fc.integer({ min: 0x20, max: 0x7e }).map((c) => String.fromCharCode(c)), minLength: 1, maxLength: 40 });

describe("verifyEvidence (property)", () => {
  it("accepts exact quotes and rejects any one-character mutation", () => {
    fc.assert(
      fc.property(printable, fc.nat(), fc.integer({ min: 0x20, max: 0x7e }), (s, pos, code) => {
        const i = pos % s.length;
        const repl = String.fromCharCode(code);
        fc.pre(repl !== s[i]);
        const s2 = s.slice(0, i) + repl + s.slice(i + 1);
        const q: QueryResult = {
          queryId: "q1", templateId: "t", logGroups: ["g"], window: { startMs: 0, endMs: 1 }, queryString: "q",
          status: "Complete", rows: [{ f: s }], bytesScanned: 0, truncated: false,
        };
        const mk = (v: string): Hypothesis => ({ rank: 1, category: "TIMEOUT", summary: "s", evidence: [{ queryId: "q1", row: 0, quote: { f: v } }] });
        const ok = verifyEvidence([mk(s)], [q]);
        const bad = verifyEvidence([mk(s2)], [q]);
        return ok.verified.length === 1 && bad.verified.length === 0 && bad.dropped.length === 1;
      }),
      { numRuns: 1000 },
    );
  });
});
