import { numParam, type FaultFlag } from "../chaos/flag.js";
import { chance, intBetween, type Rng } from "../core/rng.js";
import type { Logger } from "./logger.js";
import { ORDERS_TIMEOUT_MS } from "./platform.js";

export interface OrderRequest { orderId: string; customerEmail: string; quantity: number; giftWrap: boolean; amountCents: number }
export interface OrderOutcome { statusCode: number; durationMs: number; timedOut: boolean }

export interface DemoDeps {
  log: Logger;
  rng: Rng;
  clock: { now(): number; advance(ms: number): void };
  fault: FaultFlag | null;
  functionVersion: string;
  putOrder(o: OrderRequest): Promise<void>;
  callPayments(r: { orderId: string; amountCents: number }): Promise<{ status: number; latencyMs: number }>;
}

/** The real order-handling logic. The simulator and the Lambda both run exactly this code. */
export async function handleOrder(req: OrderRequest, deps: DemoDeps): Promise<OrderOutcome> {
  const { log, clock, fault } = deps;
  const start = clock.now();
  const complete = (code: number): OrderOutcome => {
    const durationMs = clock.now() - start;
    log.info("request complete", { statusCode: code, durationMs });
    return { statusCode: code, durationMs, timedOut: false };
  };

  log.info("order received", { orderId: req.orderId, customerEmail: req.customerEmail, quantity: req.quantity });

  if (req.quantity <= 0) {
    log.warn("invalid order", { orderId: req.orderId, errorType: "ValidationError", statusCode: 400 });
    return complete(400);
  }

  if (fault?.fault === "bad_deploy" && deps.functionVersion === String(fault.params.version) && req.giftWrap) {
    log.error("unhandled error", {
      orderId: req.orderId,
      errorType: "TypeError",
      errorMessage: "Cannot read properties of undefined (reading 'sku')",
    });
    return complete(500);
  }

  const pay = await deps.callPayments({ orderId: req.orderId, amountCents: req.amountCents });
  clock.advance(pay.latencyMs);
  if (clock.now() - start > ORDERS_TIMEOUT_MS) {
    return { statusCode: 504, durationMs: ORDERS_TIMEOUT_MS, timedOut: true };
  }
  if (pay.status >= 500) {
    log.error("payments call failed", {
      orderId: req.orderId, downstream: "payments", downstreamStatus: pay.status, downstreamMs: pay.latencyMs, errorType: "DownstreamError",
    });
    return complete(502);
  }
  log.info("payments call ok", { orderId: req.orderId, downstream: "payments", downstreamStatus: 200, downstreamMs: pay.latencyMs });

  clock.advance(intBetween(deps.rng, 5, 15));
  if (fault?.fault === "ddb_throttle" && chance(deps.rng, numParam(fault, "rate", 0))) {
    log.error("order write failed", { orderId: req.orderId, errorType: "ProvisionedThroughputExceededException", tableName: "rca-demo-orders" });
    return complete(500);
  }
  await deps.putOrder(req);
  return complete(201);
}
