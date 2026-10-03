import { toIso } from "../core/time.js";
import type { AlarmEvent } from "../core/types.js";
import type { IncidentStore } from "../ports/incidentStore.js";

export interface DedupeConfig { groupingWindowMs: number; queriesAllowed: number; dailyTokenCap: number; estimatedTokensPerInvestigation: number }
export const DEFAULT_DEDUPE_CONFIG: DedupeConfig = {
  groupingWindowMs: 10 * 60_000,
  queriesAllowed: 6,
  dailyTokenCap: 2_000_000,
  estimatedTokensPerInvestigation: 12_000,
};

export type DedupeDecision =
  | { action: "INVESTIGATE"; incidentId: string; alarm: AlarmEvent }
  | { action: "SUPPRESS"; incidentId: string; alarm: AlarmEvent }
  | { action: "BUDGET_EXHAUSTED"; incidentId: string; alarm: AlarmEvent }
  | { action: "IGNORE"; incidentId: null; alarm: AlarmEvent };

/** "inc-YYYYMMDDHHmm-xxxxxx" with 6 hex digits. */
export function newIncidentId(nowMs: number, rnd: () => number = Math.random): string {
  const stamp = toIso(nowMs).slice(0, 16).replace(/[-T:]/g, "");
  const suffix = Math.floor(rnd() * 0x1000000).toString(16).padStart(6, "0");
  return `inc-${stamp}-${suffix}`;
}

/** I3-I5: one incident per service window (I5) and a daily token cap (I4). */
export async function dedupeAndBudget(
  alarm: AlarmEvent,
  deps: { store: IncidentStore; nowMs: number; newId: () => string; config?: Partial<DedupeConfig> },
): Promise<DedupeDecision> {
  const cfg = { ...DEFAULT_DEDUPE_CONFIG, ...deps.config };
  if (alarm.state !== "ALARM") return { action: "IGNORE", incidentId: null, alarm };

  const incidentId = deps.newId();
  const opened = await deps.store.openIncident(
    { incidentId, service: alarm.service, alarms: [alarm.alarmName], openedAtMs: deps.nowMs, status: "INVESTIGATING" },
    { nowMs: deps.nowMs, windowMs: cfg.groupingWindowMs, queriesAllowed: cfg.queriesAllowed },
  );
  if (!opened.opened) {
    await deps.store.appendAlarm(opened.incidentId, alarm.alarmName);
    return { action: "SUPPRESS", incidentId: opened.incidentId, alarm };
  }

  const day = toIso(deps.nowMs).slice(0, 10);
  const ok = await deps.store.reserveDailyTokens(day, cfg.estimatedTokensPerInvestigation, cfg.dailyTokenCap);
  if (!ok) {
    await deps.store.setStatus(incidentId, "BUDGET_EXHAUSTED");
    return { action: "BUDGET_EXHAUSTED", incidentId, alarm };
  }
  return { action: "INVESTIGATE", incidentId, alarm };
}
