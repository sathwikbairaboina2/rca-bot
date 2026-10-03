import { z } from "zod";

export const FAULTS = ["ddb_throttle", "downstream_5xx", "timeout", "bad_deploy", "cold_start"] as const;
export type Fault = (typeof FAULTS)[number];

export const FaultFlagSchema = z.object({
  scenarioId: z.string(),
  fault: z.enum(FAULTS),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
  until: z.string(),
});
export type FaultFlag = z.infer<typeof FaultFlagSchema>;

/** Never throws: anything that is not a valid flag means "no fault". */
export function parseFlag(raw: string | null | undefined): FaultFlag | null {
  if (!raw || raw.trim() === "" || raw.trim() === "{}") return null;
  try {
    const r = FaultFlagSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** I7: an expired flag is never active, even if nobody reverted it. */
export function activeFault(flag: FaultFlag | null, nowMs: number): FaultFlag | null {
  if (!flag) return null;
  const until = Date.parse(flag.until);
  if (!Number.isFinite(until) || until <= nowMs) return null;
  return flag;
}

export function numParam(flag: FaultFlag, key: string, fallback: number): number {
  const v = flag.params[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
