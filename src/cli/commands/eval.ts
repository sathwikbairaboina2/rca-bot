import { join } from "node:path";
import { parseArgs } from "node:util";
import { runFabricationBench } from "../../eval/fabricationBench.js";
import { runEval } from "../../eval/runEval.js";
import { modelSlug } from "../../model/factory.js";
import type { CliIo } from "../io.js";

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export async function evalCommand(args: string[], io: CliIo): Promise<number> {
  const sub = args[0];
  const { values } = parseArgs({
    args: args.slice(1),
    options: { model: { type: "string" }, scenarios: { type: "string" }, repeat: { type: "string" }, out: { type: "string" } },
  });
  const repeat = values.repeat ? Number(values.repeat) : 3;
  if (!Number.isInteger(repeat) || repeat < 1) {
    io.stderr("--repeat must be a positive integer");
    return 2;
  }

  if (sub === "run") {
    const spec = values.model ?? io.env.RCA_MODEL ?? "heuristic";
    const ids = !values.scenarios || values.scenarios === "all" ? "all" : values.scenarios.split(",").map((s) => s.trim()).filter(Boolean);
    const outFile = values.out ?? join(io.cwd, "bench", "results", `eval-${modelSlug(spec)}.json`);
    const report = await runEval({
      modelSpec: spec, scenarioIds: ids, repeat, outFile, env: io.env,
      onRun: (r, i, total) =>
        io.stdout(`[${i}/${total}] ${r.scenarioId} seed ${r.seed}: ${r.status} top1=${r.top1 ? "✓" : "✗"} ${r.ms} ms${r.error ? ` (${r.error})` : ""}`),
    });
    const s = report.summary;
    io.stdout("");
    io.stdout(`model            ${report.model}`);
    io.stdout(`runs             ${s.n} (errors ${s.errorCount})`);
    io.stdout(`top-1            ${pct(s.top1Rate)}`);
    io.stdout(`top-2            ${pct(s.top2Rate)}`);
    io.stdout(`inconclusive     ${pct(s.inconclusiveRate)}`);
    io.stdout(`unverified posted ${s.unverifiedPostedTotal}`);
    io.stdout(`median ms        ${s.medianMs}`);
    io.stdout(`tokens           ${s.inputTokens} in / ${s.outputTokens} out`);
    io.stdout(`written to       ${outFile}`);
    if (s.unverifiedPostedTotal > 0) {
      io.stderr("INVARIANT BROKEN: an unverified claim was posted");
      return 1;
    }
    return 0;
  }

  if (sub === "fabrication") {
    const outFile = values.out ?? join(io.cwd, "bench", "results", "fabrication.json");
    const r = await runFabricationBench({ repeat, outFile });
    io.stdout(`fabricated citations blocked  ${r.fabricatedBlocked}/${r.fabricatedInjected}`);
    for (const [k, v] of Object.entries(r.byKind)) io.stdout(`  ${k.padEnd(6)} ${v.blocked}/${v.injected}`);
    io.stdout(`honest hypotheses kept        ${r.honestKept}/${r.honestInjected}`);
    io.stdout(`unverified posted             ${r.unverifiedPostedTotal}`);
    io.stdout(`written to                    ${outFile}`);
    if (r.fabricatedBlocked < r.fabricatedInjected || r.unverifiedPostedTotal > 0) {
      io.stderr("INVARIANT BROKEN: a fabricated citation was not blocked");
      return 1;
    }
    return 0;
  }

  io.stderr("usage: rca eval run --model <spec> [--scenarios all|id,id] [--repeat 3] [--out <file>] | rca eval fabrication [--repeat 3] [--out <file>]");
  return 2;
}
