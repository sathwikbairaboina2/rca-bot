import { LexError, tokenize, type Token } from "./lexer.js";

export type Literal = string | number;
export type Expr =
  | { kind: "and" | "or"; left: Expr; right: Expr }
  | { kind: "not"; expr: Expr }
  | { kind: "cmp"; field: string; op: "=" | "!=" | "<" | "<=" | ">" | ">="; value: Literal }
  | { kind: "like"; field: string; value: string }
  | { kind: "in"; field: string; values: Literal[] }
  | { kind: "ispresent"; field: string };
export interface Agg { fn: "count" | "sum" | "avg" | "min" | "max" | "pct"; arg: string; p?: number; as: string }
export type Command =
  | { kind: "fields"; fields: string[] }
  | { kind: "filter"; expr: Expr }
  | { kind: "stats"; aggs: Agg[]; by: string[] }
  | { kind: "sort"; field: string; dir: "asc" | "desc" }
  | { kind: "limit"; n: number };

export class InsightsParseError extends Error {
  constructor(message: string, readonly position: number) { super(message); this.name = "InsightsParseError"; }
}

const FNS = ["count", "sum", "avg", "min", "max", "pct"] as const;
const CMP_OPS = ["=", "!=", "<", "<=", ">", ">="] as const;

class Parser {
  private i = 0;
  constructor(private readonly toks: Token[]) {}

  private get cur(): Token { return this.toks[this.i]!; }
  private fail(msg: string): never { throw new InsightsParseError(msg, this.cur.pos); }
  private isKw(kw: string): boolean { return this.cur.type === "ident" && this.cur.text.toLowerCase() === kw; }
  private isPunct(p: string): boolean { return this.cur.type === "punct" && this.cur.text === p; }
  private eatKw(kw: string): boolean { if (this.isKw(kw)) { this.i++; return true; } return false; }
  private eatPunct(p: string): boolean { if (this.isPunct(p)) { this.i++; return true; } return false; }
  private expectPunct(p: string): void { if (!this.eatPunct(p)) this.fail(`expected '${p}'`); }

  parse(): Command[] {
    const cmds = [this.command()];
    while (this.eatPunct("|")) cmds.push(this.command());
    if (this.cur.type !== "eof") this.fail(`unexpected token '${this.cur.text}'`);
    return cmds;
  }

  private command(): Command {
    if (this.eatKw("fields")) return { kind: "fields", fields: this.fieldList() };
    if (this.eatKw("filter")) return { kind: "filter", expr: this.expr() };
    if (this.eatKw("stats")) {
      const aggs = [this.agg()];
      while (this.eatPunct(",")) aggs.push(this.agg());
      const by = this.eatKw("by") ? this.fieldList() : [];
      return { kind: "stats", aggs, by };
    }
    if (this.eatKw("sort")) {
      const field = this.field();
      let dir: "asc" | "desc" = "asc";
      if (this.eatKw("desc")) dir = "desc";
      else this.eatKw("asc");
      return { kind: "sort", field, dir };
    }
    if (this.eatKw("limit")) {
      if (this.cur.type !== "number" || !Number.isInteger(this.cur.value)) this.fail("limit needs an integer");
      const n = this.cur.value as number;
      if (n < 1 || n > 10000) this.fail("limit must be 1..10000");
      this.i++;
      return { kind: "limit", n };
    }
    return this.fail(`unknown command '${this.cur.text}'`);
  }

  private field(): string {
    if (this.cur.type !== "ident") this.fail("expected field name");
    return this.toks[this.i++]!.text;
  }
  private fieldList(): string[] {
    const f = [this.field()];
    while (this.eatPunct(",")) f.push(this.field());
    return f;
  }

  private agg(): Agg {
    if (this.cur.type !== "ident") this.fail("expected aggregate function");
    const fn = this.cur.text.toLowerCase();
    if (!(FNS as readonly string[]).includes(fn)) this.fail(`unknown function '${this.cur.text}'`);
    this.i++;
    this.expectPunct("(");
    let arg: string;
    if (this.eatPunct("*")) {
      if (fn !== "count") this.fail(`${fn}(*) is not allowed`);
      arg = "*";
    } else arg = this.field();
    let p: number | undefined;
    if (this.eatPunct(",")) {
      if (fn !== "pct") this.fail(`${fn} does not take a percentile`);
      if (this.cur.type !== "number") this.fail("expected percentile number");
      p = this.cur.value as number;
      if (!(p > 0 && p <= 100)) this.fail("percentile must be in (0,100]");
      this.i++;
    } else if (fn === "pct") this.fail("pct needs a percentile");
    this.expectPunct(")");
    let as = `${fn}(${arg}${p !== undefined ? `, ${p}` : ""})`;
    if (this.eatKw("as")) {
      if (this.cur.type !== "ident" || this.cur.text.startsWith("@")) this.fail("expected alias after 'as'");
      as = this.toks[this.i++]!.text;
    }
    const agg: Agg = { fn: fn as Agg["fn"], arg, as };
    if (p !== undefined) agg.p = p;
    return agg;
  }

  private expr(): Expr {
    let left = this.and();
    while (this.eatKw("or")) left = { kind: "or", left, right: this.and() };
    return left;
  }
  private and(): Expr {
    let left = this.unary();
    while (this.eatKw("and")) left = { kind: "and", left, right: this.unary() };
    return left;
  }
  private unary(): Expr {
    if (this.eatKw("not")) return { kind: "not", expr: this.unary() };
    return this.primary();
  }
  private literal(): Literal {
    if (this.cur.type === "string" || this.cur.type === "number") return this.toks[this.i++]!.value as Literal;
    return this.fail("expected string or number");
  }
  private primary(): Expr {
    if (this.eatPunct("(")) {
      const e = this.expr();
      this.expectPunct(")");
      return e;
    }
    if (this.isKw("ispresent") && this.toks[this.i + 1]?.text === "(") {
      this.i++;
      this.expectPunct("(");
      const field = this.field();
      this.expectPunct(")");
      return { kind: "ispresent", field };
    }
    const field = this.field();
    if (this.cur.type === "op") {
      const op = this.cur.text;
      if (!(CMP_OPS as readonly string[]).includes(op)) this.fail(`bad operator ${op}`);
      this.i++;
      return { kind: "cmp", field, op: op as (typeof CMP_OPS)[number], value: this.literal() };
    }
    if (this.eatKw("like")) {
      if (this.cur.type !== "string") this.fail("like needs a string");
      return { kind: "like", field, value: this.toks[this.i++]!.value as string };
    }
    if (this.eatKw("in")) {
      this.expectPunct("[");
      const values = [this.literal()];
      while (this.eatPunct(",")) values.push(this.literal());
      this.expectPunct("]");
      return { kind: "in", field, values };
    }
    return this.fail("expected comparison, like or in");
  }
}

export function parseQuery(query: string): Command[] {
  let toks: Token[];
  try {
    toks = tokenize(query);
  } catch (e) {
    if (e instanceof LexError) throw new InsightsParseError(e.message, e.position);
    throw e;
  }
  return new Parser(toks).parse();
}
