import { mulberry32, type Rng } from "../core/rng.js";
import type { Evidence, Hypothesis } from "../core/types.js";
import { extractSection, parseResultsSection } from "./prompts.js";
import type { Model, ModelRequest, ModelResponse } from "./types.js";

export type FabricationKind = "char" | "row" | "query" | "field";
const KINDS: FabricationKind[] = ["char", "row", "query", "field"];

/** Wraps a model and injects hypotheses with deliberately fabricated citations, to measure that the verifier blocks them. */
export class FabricatorModel implements Model {
  readonly id: string;
  readonly log: { honest: string[]; fabricated: { kind: FabricationKind; summary: string }[] } = { honest: [], fabricated: [] };
  private readonly rng: Rng;
  private calls = 0;

  constructor(private readonly inner: Model, opts: { seed: number }) {
    this.id = `fabricator(${inner.id})`;
    this.rng = mulberry32(opts.seed);
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const res = await this.inner.complete(req);
    if (req.purpose !== "hypothesize") return res;
    let hyps: Hypothesis[];
    try {
      hyps = (JSON.parse(res.text) as { hypotheses?: Hypothesis[] }).hypotheses ?? [];
    } catch {
      return res;
    }
    const honest = hyps[0];
    if (!honest) return res;
    this.log.honest.push(honest.summary);
    const results = parseResultsSection(extractSection(req.user, "results") ?? "");
    const c = this.calls++;
    const fabricated = [KINDS[(2 * c) % 4]!, KINDS[(2 * c + 1) % 4]!].map((kind) => {
      const h: Hypothesis = {
        rank: 0,
        category: honest.category,
        summary: `[fabricated:${kind}] ${honest.summary}`,
        evidence: honest.evidence.map((e, i) => (i === 0 ? this.mutate(kind, e, results) : e)),
      };
      this.log.fabricated.push({ kind, summary: h.summary });
      return h;
    });
    const all = [...fabricated, honest].map((h, i) => ({ ...h, rank: i + 1 }));
    return { ...res, text: JSON.stringify({ hypotheses: all }) };
  }

  private mutate(kind: FabricationKind, e: Evidence, results: ReturnType<typeof parseResultsSection>): Evidence {
    const quote = { ...e.quote };
    const field = Object.keys(quote)[0]!;
    if (kind === "query") return { ...e, queryId: "q99", quote };
    if (kind === "field") return { ...e, quote: { ...quote, errorCode: "E_ROOT_CAUSE" } };
    if (kind === "row") {
      const rows = results.find((r) => r.queryId === e.queryId)?.rows ?? [];
      const original = String(quote[field]);
      const other = rows.findIndex((r, i) => i !== e.row && r && r[field] !== undefined && r[field] !== original);
      return { ...e, row: other >= 0 ? other : e.row + 1000, quote };
    }
    const s = String(quote[field]);
    const idx = Math.floor(this.rng() * s.length);
    const ch = s[idx] ?? "";
    const repl = /[0-9]/.test(ch) ? String((Number(ch) + 1 + Math.floor(this.rng() * 8)) % 10) : ch === "x" ? "y" : "x";
    quote[field] = s.length === 0 ? "x" : s.slice(0, idx) + repl + s.slice(idx + 1);
    return { ...e, quote };
  }
}
