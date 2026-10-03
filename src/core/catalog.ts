import { parseQuery } from "./insights/parser.js";
import type { PlannedQuery, QuerySelection, TimeWindow } from "./types.js";

export interface QueryTemplate { id: string; description: string; query: string; usesFilterValue: boolean }

export const CATALOG: readonly QueryTemplate[] = [
  { id: "errors_by_message", description: "Top ERROR log lines grouped by errorType and message", usesFilterValue: false,
    query: 'filter level = "ERROR" | stats count(*) as n by errorType, message | sort n desc | limit 20' },
  { id: "status_by_version", description: "Responses grouped by function version and HTTP status code", usesFilterValue: false,
    query: 'filter message = "request complete" | stats count(*) as n by functionVersion, statusCode | sort n desc | limit 20' },
  { id: "latency_by_version", description: "Handler p99 and average duration (ms) by function version", usesFilterValue: false,
    query: 'filter message = "request complete" | stats pct(durationMs, 99) as p99Ms, avg(durationMs) as avgMs, count(*) as n by functionVersion | sort p99Ms desc | limit 20' },
  { id: "throttling_exceptions", description: "Throttling exceptions by type and table", usesFilterValue: false,
    query: 'filter errorType like "Throttl" or errorType = "ProvisionedThroughputExceededException" | stats count(*) as n by errorType, tableName | sort n desc | limit 20' },
  { id: "cold_starts", description: "Lambda cold starts, max init duration and p99 duration per log group (REPORT lines)", usesFilterValue: false,
    query: 'filter @type = "REPORT" | stats count(@initDuration) as coldStarts, count(*) as invocations, max(@initDuration) as maxInitMs, pct(@duration, 99) as p99DurationMs by @log | limit 20' },
  { id: "downstream_status", description: "Downstream calls by dependency and status code with p99 latency", usesFilterValue: false,
    query: 'filter ispresent(downstreamStatus) | stats count(*) as n, pct(downstreamMs, 99) as p99Ms by downstream, downstreamStatus | sort n desc | limit 20' },
  { id: "timeouts", description: "Lambda 'Task timed out' lines per log group", usesFilterValue: false,
    query: 'filter @message like "Task timed out" | stats count(*) as n by @log | sort n desc | limit 20' },
  { id: "message_search", description: "Most recent lines whose raw message contains filterValue", usesFilterValue: true,
    query: "filter @message like {{filterValue}} | fields @timestamp, @log, level, message, errorType | sort @timestamp desc | limit 20" },
];

export const FILTER_VALUE_RE = /^[A-Za-z0-9_.:\/ -]{1,80}$/;
export const MAX_WINDOW_MS = 60 * 60_000;
export const MAX_LOG_GROUPS = 5;

export class CatalogError extends Error { constructor(message: string) { super(message); this.name = "CatalogError"; } }

export function getTemplate(id: string): QueryTemplate {
  const t = CATALOG.find((c) => c.id === id);
  if (!t) throw new CatalogError(`unknown template ${id}`);
  return t;
}

function validateFilterValue(v: unknown): string {
  if (typeof v !== "string" || !FILTER_VALUE_RE.test(v) || /^/.*/$/.test(v)) {
    throw new CatalogError("filterValue must match " + FILTER_VALUE_RE.source + " and must not look like a /regex/");
  }
  return v;
}

const ALLOWED_KEYS = new Set(["templateId", "logGroups", "filterValue"]);

export function validateSelection(sel: unknown, allowedLogGroups: readonly string[]): QuerySelection {
  if (!sel || typeof sel !== "object" || Array.isArray(sel)) throw new CatalogError("selection must be an object");
  const o = sel as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!ALLOWED_KEYS.has(k)) throw new CatalogError(`unexpected key ${k}`);
  if (typeof o.templateId !== "string") throw new CatalogError("templateId must be a string");
  const tpl = getTemplate(o.templateId);
  if (!Array.isArray(o.logGroups) || o.logGroups.length === 0 || !o.logGroups.every((g) => typeof g === "string")) {
    throw new CatalogError("logGroups must be a non-empty string array");
  }
  const groups = [...new Set(o.logGroups as string[])];
  for (const g of groups) if (!allowedLogGroups.includes(g)) throw new CatalogError(`log group not allowed: ${g}`);
  if (groups.length > MAX_LOG_GROUPS) throw new CatalogError(`at most ${MAX_LOG_GROUPS} log groups`);
  const out: QuerySelection = { templateId: tpl.id, logGroups: groups };
  if (tpl.usesFilterValue) {
    if (o.filterValue === undefined) throw new CatalogError(`template ${tpl.id} needs filterValue`);
    out.filterValue = validateFilterValue(o.filterValue);
  } else if (o.filterValue !== undefined) {
    throw new CatalogError(`template ${tpl.id} does not take filterValue`);
  }
  return out;
}

export function incidentWindow(alarmTimeMs: number): TimeWindow {
  return { startMs: alarmTimeMs - 30 * 60_000, endMs: alarmTimeMs + 2 * 60_000 };
}

/** Result always lies inside `incident` and spans at most MAX_WINDOW_MS. */
export function clampWindow(requested: TimeWindow, incident: TimeWindow): TimeWindow {
  let startMs = Math.max(requested.startMs, incident.startMs);
  // A request entirely before the incident collapses to an empty window at the incident start.
  const endMs = Math.max(incident.startMs, Math.min(requested.endMs, incident.endMs));
  if (endMs - startMs > MAX_WINDOW_MS) startMs = endMs - MAX_WINDOW_MS;
  if (endMs < startMs) startMs = endMs;
  return { startMs, endMs };
}

export function renderQuery(sel: QuerySelection): string {
  const tpl = getTemplate(sel.templateId);
  let q = tpl.query;
  if (tpl.usesFilterValue) {
    const v = validateFilterValue(sel.filterValue);
    const escaped = v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    q = q.replace("{{filterValue}}", () => `"${escaped}"`);
  }
  try {
    parseQuery(q);
  } catch (e) {
    throw new CatalogError(`template ${tpl.id} does not parse: ${(e as Error).message}`);
  }
  return q;
}

export function planQuery(queryId: string, sel: QuerySelection, incident: TimeWindow): PlannedQuery {
  return {
    queryId,
    templateId: sel.templateId,
    logGroups: sel.logGroups,
    window: clampWindow(incident, incident),
    queryString: renderQuery(sel),
  };
}

export function lintCatalog(): { id: string; ok: boolean; error?: string }[] {
  return CATALOG.map((t) => {
    try {
      renderQuery({ templateId: t.id, logGroups: ["g"], ...(t.usesFilterValue ? { filterValue: "x" } : {}) });
      return { id: t.id, ok: true };
    } catch (e) {
      return { id: t.id, ok: false, error: (e as Error).message };
    }
  });
}
