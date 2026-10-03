export const CATEGORIES = [
  "DEPENDENCY_THROTTLING",
  "DEPENDENCY_ERRORS",
  "TIMEOUT",
  "BAD_DEPLOY",
  "COLD_START_STORM",
  "CONFIG_ERROR",
  "CAPACITY",
  "UNKNOWN",
] as const;
export type Category = (typeof CATEGORIES)[number];
export function isCategory(v: unknown): v is Category {
  return typeof v === "string" && (CATEGORIES as readonly string[]).includes(v);
}

/** One query result row. Values are strings, exactly like CloudWatch GetQueryResults. */
export type Row = Record<string, string>;

/** A CloudWatch Logs event. `fields` holds system fields Logs Insights discovers itself (e.g. @type, @duration on REPORT lines). */
export interface LogEvent {
  timestamp: number; // epoch ms
  logGroup: string;
  logStream: string;
  message: string;
  fields?: Record<string, string | number>;
}

export interface TimeWindow { startMs: number; endMs: number }

export interface AlarmEvent {
  alarmName: string;
  service: string;
  state: "ALARM" | "OK" | "INSUFFICIENT_DATA";
  timeMs: number;
  reason: string;
  metricName: string;
}

export interface DeployEvent { atMs: number; functionName: string; fromVersion: string; toVersion: string }
export interface MetricPoint { tMs: number; value: number }
export interface MetricSeries { name: string; unit: string; points: MetricPoint[] }

/** What the model may ask for. Nothing else reaches a query string. */
export interface QuerySelection { templateId: string; logGroups: string[]; filterValue?: string }

export interface PlannedQuery {
  queryId: string; // "q1", "q2", ...
  templateId: string;
  logGroups: string[];
  window: TimeWindow;
  queryString: string;
}

export type QueryStatus = "Complete" | "Failed" | "Timeout";
export interface QueryResult extends PlannedQuery {
  status: QueryStatus;
  rows: Row[];
  bytesScanned: number;
  truncated: boolean;
  error?: string;
}

export interface Evidence { queryId: string; row: number; quote: Record<string, string | number> }
/** Model output before verification. `category` is a plain string because unverified input may be junk. */
export interface Hypothesis { rank: number; category: string; summary: string; evidence: Evidence[] }
export type Confidence = "High" | "Medium" | "Low";
export interface VerifiedHypothesis { rank: number; category: Category; summary: string; evidence: Evidence[]; confidence: Confidence }
export interface DroppedHypothesis { hypothesis: Hypothesis; reason: string }

export type IncidentStatus = "INVESTIGATING" | "POSTED" | "INCONCLUSIVE" | "SUPPRESSED" | "BUDGET_EXHAUSTED";
export interface Usage { inputTokens: number; outputTokens: number }

export interface InvestigationContext {
  alarm: AlarmEvent;
  service: string;
  window: TimeWindow;
  logGroups: string[];
  deploys: DeployEvent[];
  metrics: MetricSeries[];
}

export interface GroundTruth { scenarioId: string; fault: string; category: Category }

export interface IncidentReport {
  incidentId: string;
  service: string;
  alarms: string[];
  status: IncidentStatus;
  openedAtMs: number;
  context: InvestigationContext | null; // null when SUPPRESSED / BUDGET_EXHAUSTED
  queries: QueryResult[];
  posted: VerifiedHypothesis[];
  dropped: DroppedHypothesis[];
  model: string;
  modelCalls: number;
  usage: Usage;
  notes: string[];
}
