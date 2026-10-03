import type { LogEvent, Row } from "../types.js";
import { formatInsightsTimestamp } from "../time.js";
import { parseQuery, type Command, type Expr, type Literal } from "./parser.js";

type Value = string | number;
type Rec = Record<string, Value>;

function flatten(obj: Record<string, unknown>, prefix: string, out: Rec): void {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v === null || v === undefined) continue;
    if (typeof v === "string" || typeof v === "number") out[key] = v;
    else if (typeof v === "boolean") out[key] = v ? "true" : "false";
    else if (Array.isArray(v)) continue;
    else if (typeof v === "object") flatten(v as Record<string, unknown>, key, out);
  }
}

/**
 * Fields Logs Insights would discover for an event. `@log` is the bare log group name here;
 * AWS prefixes the account id ("123456789012:/aws/lambda/x"), which we do not model.
 */
export function discoverFields(e: LogEvent): Rec {
  const rec: Rec = {
    "@timestamp": formatInsightsTimestamp(e.timestamp),
    "@message": e.message,
    "@logStream": e.logStream,
    "@log": e.logGroup,
  };
  if (e.fields) for (const [k, v] of Object.entries(e.fields)) rec[k] = v;
  try {
    const parsed: unknown = JSON.parse(e.message);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) flatten(parsed as Record<string, unknown>, "", rec);
  } catch {
    // not JSON: keep system fields only
  }
  return rec;
}

function isNumeric(v: Value | undefined): v is Value {
  if (v === undefined || v === "") return false;
  return Number.isFinite(Number(v));
}

function matches(v: Value, lit: Literal, op: "=" | "!=" | "<" | "<=" | ">" | ">="): boolean {
  if (typeof lit === "number" && isNumeric(v)) {
    const a = Number(v);
    switch (op) {
      case "=": return a === lit;
      case "!=": return a !== lit;
      case "<": return a < lit;
      case "<=": return a <= lit;
      case ">": return a > lit;
      case ">=": return a >= lit;
    }
  }
  const a = String(v), b = String(lit);
  switch (op) {
    case "=": return a === b;
    case "!=": return a !== b;
    case "<": return a < b;
    case "<=": return a <= b;
    case ">": return a > b;
    case ">=": return a >= b;
  }
}

function evalExpr(e: Expr, r: Rec): boolean {
  switch (e.kind) {
    case "and": return evalExpr(e.left, r) && evalExpr(e.right, r);
    case "or": return evalExpr(e.left, r) || evalExpr(e.right, r);
    case "not": return !evalExpr(e.expr, r);
    case "cmp": { const v = r[e.field]; return v !== undefined && matches(v, e.value, e.op); }
    case "like": { const v = r[e.field]; return v !== undefined && String(v).includes(e.value); }
    case "in": { const v = r[e.field]; return v !== undefined && e.values.some((l) => matches(v, l, "=")); }
    case "ispresent": { const v = r[e.field]; return v !== undefined && v !== ""; }
  }
}

function present(v: Value | undefined): v is Value {
  return v !== undefined && v !== "";
}

function runStats(cmd: Extract<Command, { kind: "stats" }>, recs: Rec[]): Rec[] {
  const groups = new Map<string, { by: Rec; recs: Rec[] }>();
  for (const r of recs) {
    const key = JSON.stringify(cmd.by.map((f) => (r[f] === undefined ? null : r[f])));
    let g = groups.get(key);
    if (!g) {
      const by: Rec = {};
      for (const f of cmd.by) if (r[f] !== undefined) by[f] = r[f]!;
      g = { by, recs: [] };
      groups.set(key, g);
    }
    g.recs.push(r);
  }
  const out: Rec[] = [];
  for (const g of groups.values()) {
    const row: Rec = { ...g.by };
    for (const a of cmd.aggs) {
      if (a.fn === "count") {
        row[a.as] = a.arg === "*" ? g.recs.length : g.recs.filter((r) => present(r[a.arg])).length;
        continue;
      }
      const nums = g.recs.map((r) => r[a.arg]).filter(isNumeric).map(Number);
      if (nums.length === 0) continue;
      switch (a.fn) {
        case "sum": row[a.as] = nums.reduce((x, y) => x + y, 0); break;
        case "avg": row[a.as] = nums.reduce((x, y) => x + y, 0) / nums.length; break;
        case "min": row[a.as] = Math.min(...nums); break;
        case "max": row[a.as] = Math.max(...nums); break;
        case "pct": {
          const sorted = [...nums].sort((x, y) => x - y);
          const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(((a.p ?? 100) / 100) * sorted.length) - 1));
          row[a.as] = sorted[idx]!;
          break;
        }
      }
    }
    out.push(row);
  }
  return out;
}

function fmt(v: Value): string {
  if (typeof v === "string") return v;
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(3)));
}

/** Evaluate a parsed or raw query over events already filtered by log group and window. */
export function evaluateQuery(query: string | Command[], events: LogEvent[]): Row[] {
  const cmds = typeof query === "string" ? parseQuery(query) : query;
  let recs: Rec[] = events.map(discoverFields);
  let projected = false;
  for (const c of cmds) {
    switch (c.kind) {
      case "filter":
        recs = recs.filter((r) => evalExpr(c.expr, r));
        break;
      case "fields":
        projected = true;
        recs = recs.map((r) => {
          const o: Rec = {};
          for (const f of c.fields) if (r[f] !== undefined) o[f] = r[f]!;
          return o;
        });
        break;
      case "stats":
        projected = true;
        recs = runStats(c, recs);
        break;
      case "sort": {
        const dir = c.dir === "asc" ? 1 : -1;
        recs = recs
          .map((r, i) => ({ r, i }))
          .sort((x, y) => {
            const a = x.r[c.field], b = y.r[c.field];
            if (a === undefined && b === undefined) return x.i - y.i;
            if (a === undefined) return 1;
            if (b === undefined) return -1;
            let cmp: number;
            if (isNumeric(a) && isNumeric(b)) cmp = Number(a) - Number(b);
            else cmp = String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
            return cmp === 0 ? x.i - y.i : cmp * dir;
          })
          .map((x) => x.r);
        break;
      }
      case "limit":
        recs = recs.slice(0, c.n);
        break;
    }
  }
  return recs.map((r) => {
    const src: Rec = projected ? r : { "@timestamp": r["@timestamp"]!, "@message": r["@message"]! };
    const row: Row = {};
    for (const [k, v] of Object.entries(src)) row[k] = fmt(v);
    return row;
  });
}
