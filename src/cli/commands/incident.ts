import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { IncidentReport } from "../../core/types.js";
import { renderTerminal } from "../../slack/render.js";
import type { CliIo } from "../io.js";

export async function incidentCommand(args: string[], io: CliIo): Promise<number> {
  if (args[0] !== "show") {
    io.stderr("usage: rca incident show <incidentId> | --latest [--raw]");
    return 2;
  }
  const { values, positionals } = parseArgs({
    args: args.slice(1),
    allowPositionals: true,
    options: { latest: { type: "boolean" }, raw: { type: "boolean" } },
  });
  const dir = join(io.cwd, ".rca", "incidents");
  let file: string | null = null;
  if (values.latest) {
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
    let best = -1;
    for (const n of names) {
      const m = (await stat(join(dir, n))).mtimeMs;
      if (m > best) { best = m; file = join(dir, n); }
    }
  } else if (positionals[0]) {
    if (!/^[A-Za-z0-9._-]+$/.test(positionals[0])) {
      io.stderr(`invalid incident id ${positionals[0]}`);
      return 2;
    }
    file = join(dir, `${positionals[0]}.json`);
  } else {
    io.stderr("usage: rca incident show <incidentId> | --latest [--raw]");
    return 2;
  }
  let text: string;
  try {
    if (!file) throw new Error("none");
    text = await readFile(file, "utf8");
  } catch {
    io.stderr(`incident not found in ${dir}`);
    return 1;
  }
  io.stdout(values.raw ? text : renderTerminal(JSON.parse(text) as IncidentReport));
  return 0;
}
