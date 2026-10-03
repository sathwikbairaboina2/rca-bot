import { describe, expect, it } from "vitest";
import { prepareRowsForPrompt, redactText } from "../../src/core/redact.js";

describe("redaction", () => {
  it("redacts emails and card numbers", () => {
    expect(redactText("order for jane.doe@example.com paid with 4111 1111 1111 1111")).toBe("order for [email] paid with [card]");
  });
  it("leaves short ids alone", () => {
    expect(redactText("orderId 12345")).toBe("orderId 12345");
  });
  it("keeps 10 rows and counts omitted", () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ n: String(i) }));
    const r = prepareRowsForPrompt(rows);
    expect(r.rows).toHaveLength(10);
    expect(r.omitted).toBe(15);
  });
  it("truncates long cells", () => {
    const r = prepareRowsForPrompt([{ m: "x".repeat(500) }]);
    expect(r.rows[0]!.m).toBe("x".repeat(200) + "…[truncated]");
  });
});
