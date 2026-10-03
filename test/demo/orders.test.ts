import { describe, expect, it } from "vitest";
import { activeFault, parseFlag, type FaultFlag } from "../../src/chaos/flag.js";
import { createLogger } from "../../src/demo/logger.js";
import { handleOrder, type DemoDeps, type OrderRequest } from "../../src/demo/orders.js";

const T0 = Date.UTC(2026, 9, 3, 10, 0);
const flag = (fault: FaultFlag["fault"], params: FaultFlag["params"], until = "2099-01-01T00:00:00.000Z"): FaultFlag => ({ scenarioId: "s", fault, params, until });
const req = (o: Partial<OrderRequest> = {}): OrderRequest => ({ orderId: "o1", customerEmail: "a@example.com", quantity: 1, giftWrap: false, amountCents: 1000, ...o });

function setup(o: { fault?: FaultFlag | null; version?: string; pay?: { status: number; latencyMs: number }; rng?: number } = {}) {
  let t = T0;
  const lines: Record<string, unknown>[] = [];
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const deps: DemoDeps = {
    log: createLogger({ service: "orders", functionVersion: o.version ?? "17", requestId: "r1", now: clock.now, sink: (l) => lines.push(JSON.parse(l)) }),
    rng: () => o.rng ?? 0.1,
    clock,
    fault: o.fault ?? null,
    functionVersion: o.version ?? "17",
    putOrder: async () => {},
    callPayments: async () => o.pay ?? { status: 200, latencyMs: 30 },
  };
  return { deps, lines };
}

describe("handleOrder", () => {
  it("healthy request", async () => {
    const { deps, lines } = setup();
    const out = await handleOrder(req(), deps);
    expect(out.statusCode).toBe(201);
    expect(lines.map((l) => l.message)).toEqual(["order received", "payments call ok", "request complete"]);
  });
  it("ddb_throttle", async () => {
    const { deps, lines } = setup({ fault: flag("ddb_throttle", { rate: 0.4 }) });
    expect((await handleOrder(req(), deps)).statusCode).toBe(500);
    expect(lines.find((l) => l.level === "ERROR")).toMatchObject({ errorType: "ProvisionedThroughputExceededException", tableName: "rca-demo-orders" });
  });
  it("bad_deploy hits only v18 gift-wrapped orders", async () => {
    const f = flag("bad_deploy", { rate: 0.35, version: "18" });
    const bad = setup({ fault: f, version: "18" });
    expect((await handleOrder(req({ giftWrap: true }), bad.deps)).statusCode).toBe(500);
    expect(bad.lines.find((l) => l.level === "ERROR")).toMatchObject({ errorType: "TypeError" });
    const ok = setup({ fault: f, version: "17" });
    expect((await handleOrder(req({ giftWrap: true }), ok.deps)).statusCode).toBe(201);
  });
  it("payments 503 becomes 502", async () => {
    const { deps, lines } = setup({ pay: { status: 503, latencyMs: 40 } });
    expect((await handleOrder(req(), deps)).statusCode).toBe(502);
    expect(lines.find((l) => l.message === "payments call failed")).toMatchObject({ downstreamStatus: 503 });
  });
  it("slow payments time out with no completion line", async () => {
    const { deps, lines } = setup({ pay: { status: 200, latencyMs: 8000 } });
    const out = await handleOrder(req(), deps);
    expect(out).toMatchObject({ timedOut: true, statusCode: 504 });
    expect(lines.some((l) => l.message === "request complete")).toBe(false);
  });
  it("invalid quantity is a 400 warning", async () => {
    const { deps, lines } = setup();
    expect((await handleOrder(req({ quantity: 0 }), deps)).statusCode).toBe(400);
    expect(lines.find((l) => l.level === "WARN")).toMatchObject({ errorType: "ValidationError" });
  });
  it("an expired flag behaves as healthy", async () => {
    const expired = parseFlag(JSON.stringify(flag("ddb_throttle", { rate: 1 }, new Date(T0 - 1).toISOString())));
    const { deps } = setup({ fault: activeFault(expired, T0) });
    expect((await handleOrder(req(), deps)).statusCode).toBe(201);
  });
});
