import { numParam } from "../chaos/flag.js";
import { chance, intBetween } from "../core/rng.js";
import type { DemoDeps } from "./orders.js";

export type ChargeDeps = Pick<DemoDeps, "log" | "rng" | "fault">;

export async function handleCharge(
  req: { orderId: string; amountCents: number },
  deps: ChargeDeps,
): Promise<{ status: number; latencyMs: number }> {
  const base = intBetween(deps.rng, 20, 60);
  const f = deps.fault;
  if (f?.fault === "downstream_5xx" && chance(deps.rng, numParam(f, "rate", 0))) {
    deps.log.error("payment provider unavailable", { orderId: req.orderId, errorType: "ProviderUnavailable", statusCode: 503 });
    return { status: 503, latencyMs: base };
  }
  if (f?.fault === "timeout" && chance(deps.rng, numParam(f, "rate", 0))) {
    const providerMs = numParam(f, "providerMs", 8000);
    deps.log.warn("provider slow", { orderId: req.orderId, providerMs });
    return { status: 200, latencyMs: providerMs + intBetween(deps.rng, 0, 500) };
  }
  deps.log.info("charge ok", { orderId: req.orderId, amountCents: req.amountCents });
  return { status: 200, latencyMs: base };
}
