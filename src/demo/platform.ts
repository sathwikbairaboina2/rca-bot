import { numParam, type FaultFlag } from "../chaos/flag.js";
import { chance, intBetween, type Rng } from "../core/rng.js";

export const ORDERS_TIMEOUT_MS = 6000;
export const PAYMENTS_TIMEOUT_MS = 10000;

/** Platform behaviour a fault can alter: whether this invocation is a cold start and how long init took. */
export function coldStart(fault: FaultFlag | null, rng: Rng): { cold: boolean; initMs?: number } {
  if (fault?.fault === "cold_start") {
    if (chance(rng, numParam(fault, "rate", 1))) return { cold: true, initMs: intBetween(rng, 2500, 4500) };
    return { cold: false };
  }
  if (chance(rng, 0.02)) return { cold: true, initMs: intBetween(rng, 300, 900) };
  return { cold: false };
}
