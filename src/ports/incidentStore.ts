import type { DroppedHypothesis, IncidentStatus, VerifiedHypothesis } from "../core/types.js";

export interface IncidentMeta { incidentId: string; service: string; alarms: string[]; openedAtMs: number; status: IncidentStatus }
export interface BudgetState { queriesAllowed: number; queriesUsed: number; bytesScanned: number; tokensIn: number; tokensOut: number }
export type OpenResult = { opened: true } | { opened: false; incidentId: string };

export interface IncidentStore {
  /** Atomically: if no unexpired SVC#<service>/OPEN exists, create it (expires now+windowMs) plus META and BUDGET. */
  openIncident(meta: IncidentMeta, opts: { nowMs: number; windowMs: number; queriesAllowed: number }): Promise<OpenResult>;
  appendAlarm(incidentId: string, alarmName: string): Promise<void>;
  /** Grants min(n, remaining) atomically; returns the number granted (0..n). */
  consumeQueries(incidentId: string, n: number): Promise<number>;
  addUsage(incidentId: string, u: { tokensIn?: number; tokensOut?: number; bytesScanned?: number }): Promise<void>;
  /** Adds `tokens` to DAY#<day> only if the total stays <= cap. Returns false (and adds nothing) otherwise. */
  reserveDailyTokens(day: string, tokens: number, cap: number): Promise<boolean>;
  setStatus(incidentId: string, status: IncidentStatus): Promise<void>;
  saveHypotheses(incidentId: string, verified: VerifiedHypothesis[], dropped: DroppedHypothesis[]): Promise<void>;
  getIncident(incidentId: string): Promise<{ meta: IncidentMeta; budget: BudgetState } | null>;
}

interface Entry { meta: IncidentMeta; budget: BudgetState; verified: VerifiedHypothesis[]; dropped: DroppedHypothesis[] }

/**
 * In-memory store. Every method does its check-and-set synchronously before its first await
 * (ADR 0006), so concurrent callers behave like DynamoDB conditional writes.
 */
export class MemoryIncidentStore implements IncidentStore {
  private readonly open = new Map<string, { incidentId: string; expiresAtMs: number }>();
  private readonly incidents = new Map<string, Entry>();
  private readonly days = new Map<string, number>();

  constructor(seed: { dailyTokens?: Record<string, number> } = {}) {
    for (const [d, n] of Object.entries(seed.dailyTokens ?? {})) this.days.set(d, n);
  }

  dailyTokens(day: string): number {
    return this.days.get(day) ?? 0;
  }

  async openIncident(meta: IncidentMeta, opts: { nowMs: number; windowMs: number; queriesAllowed: number }): Promise<OpenResult> {
    const cur = this.open.get(meta.service);
    if (cur && cur.expiresAtMs >= opts.nowMs) return { opened: false, incidentId: cur.incidentId };
    this.open.set(meta.service, { incidentId: meta.incidentId, expiresAtMs: opts.nowMs + opts.windowMs });
    this.incidents.set(meta.incidentId, {
      meta: { ...meta, alarms: [...meta.alarms] },
      budget: { queriesAllowed: opts.queriesAllowed, queriesUsed: 0, bytesScanned: 0, tokensIn: 0, tokensOut: 0 },
      verified: [],
      dropped: [],
    });
    return { opened: true };
  }

  async appendAlarm(incidentId: string, alarmName: string): Promise<void> {
    this.incidents.get(incidentId)?.meta.alarms.push(alarmName);
  }

  async consumeQueries(incidentId: string, n: number): Promise<number> {
    const e = this.incidents.get(incidentId);
    if (!e) return 0;
    const grant = Math.max(0, Math.min(n, e.budget.queriesAllowed - e.budget.queriesUsed));
    e.budget.queriesUsed += grant;
    return grant;
  }

  async addUsage(incidentId: string, u: { tokensIn?: number; tokensOut?: number; bytesScanned?: number }): Promise<void> {
    const e = this.incidents.get(incidentId);
    if (!e) return;
    e.budget.tokensIn += u.tokensIn ?? 0;
    e.budget.tokensOut += u.tokensOut ?? 0;
    e.budget.bytesScanned += u.bytesScanned ?? 0;
  }

  async reserveDailyTokens(day: string, tokens: number, cap: number): Promise<boolean> {
    const used = this.days.get(day) ?? 0;
    if (used + tokens > cap) return false;
    this.days.set(day, used + tokens);
    return true;
  }

  async setStatus(incidentId: string, status: IncidentStatus): Promise<void> {
    const e = this.incidents.get(incidentId);
    if (e) e.meta.status = status;
  }

  async saveHypotheses(incidentId: string, verified: VerifiedHypothesis[], dropped: DroppedHypothesis[]): Promise<void> {
    const e = this.incidents.get(incidentId);
    if (!e) return;
    e.verified = [...verified];
    e.dropped = [...dropped];
  }

  async getIncident(incidentId: string): Promise<{ meta: IncidentMeta; budget: BudgetState } | null> {
    const e = this.incidents.get(incidentId);
    return e ? { meta: { ...e.meta, alarms: [...e.meta.alarms] }, budget: { ...e.budget } } : null;
  }
}
