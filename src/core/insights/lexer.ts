export type TokenType = "ident" | "string" | "number" | "op" | "punct" | "eof";
export interface Token { type: TokenType; text: string; value?: string | number; pos: number }

export class LexError extends Error {
  constructor(message: string, readonly position: number) { super(message); this.name = "LexError"; }
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_.]/;
const DIGIT = /[0-9]/;

/** Tokenize the Logs Insights subset. Throws LexError on any character outside the subset. */
export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { i++; continue; }
    const pos = i;
    if (c === "@" || IDENT_START.test(c)) {
      let j = i;
      if (c === "@") j++;
      if (j >= src.length || !IDENT_START.test(src[j]!)) throw new LexError("expected identifier after @", pos);
      j++;
      while (j < src.length && IDENT_PART.test(src[j]!)) j++;
      out.push({ type: "ident", text: src.slice(i, j), pos });
      i = j;
      continue;
    }
    if (DIGIT.test(c) || (c === "-" && DIGIT.test(src[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < src.length && DIGIT.test(src[j]!)) j++;
      if (src[j] === "." && DIGIT.test(src[j + 1] ?? "")) {
        j++;
        while (j < src.length && DIGIT.test(src[j]!)) j++;
      }
      const text = src.slice(i, j);
      out.push({ type: "number", text, value: Number(text), pos });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = "";
      let closed = false;
      while (j < src.length) {
        const d = src[j]!;
        if (d === "\n" || d === "\r") throw new LexError("newline in string", j);
        if (d === "\\") {
          const e = src[j + 1];
          if (e === '"' || e === "'" || e === "\\") { s += e; j += 2; continue; }
          throw new LexError("unsupported escape", j);
        }
        if (d === c) { closed = true; j++; break; }
        s += d;
        j++;
      }
      if (!closed) throw new LexError("unterminated string", pos);
      out.push({ type: "string", text: src.slice(i, j), value: s, pos });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "!=" || two === "<=" || two === ">=") { out.push({ type: "op", text: two, pos }); i += 2; continue; }
    if (c === "=" || c === "<" || c === ">") {
      if (src[i + 1] === "=" && c === "=") throw new LexError("'==' is not supported", pos);
      out.push({ type: "op", text: c, pos }); i++; continue;
    }
    if ("|,()[]*".includes(c)) { out.push({ type: "punct", text: c, pos }); i++; continue; }
    throw new LexError(`unexpected character ${JSON.stringify(c)}`, pos);
  }
  out.push({ type: "eof", text: "", pos: src.length });
  return out;
}
