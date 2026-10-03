import { lintCatalog } from "../../core/catalog.js";
import type { CliIo } from "../io.js";

export async function catalogCommand(args: string[], io: CliIo): Promise<number> {
  if (args[0] !== "lint") {
    io.stderr("usage: rca catalog lint");
    return 2;
  }
  const results = lintCatalog();
  for (const r of results) io.stdout(r.ok ? `ok   ${r.id}` : `FAIL ${r.id}: ${r.error}`);
  const bad = results.filter((r) => !r.ok).length;
  if (bad > 0) {
    io.stdout(`${bad} of ${results.length} templates FAILED`);
    return 1;
  }
  io.stdout(`${results.length} templates OK`);
  return 0;
}
