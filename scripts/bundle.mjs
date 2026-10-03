// Bundles every Lambda into build/lambda/<name>/index.mjs with esbuild. The AWS SDK is bundled (no externals) for reproducibility.
import { build } from "esbuild";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entriesDir = join(root, "build", "entries");
mkdirSync(entriesDir, { recursive: true });

const direct = { orders: "src/handlers/orders.ts", payments: "src/handlers/payments.ts", chaos: "src/handlers/chaos.ts" };
const investigator = {
  dedupe: "dedupeHandler",
  gatherContext: "gatherContextHandler",
  plan: "planHandler",
  runQuery: "runQueryHandler",
  hypothesize: "hypothesizeHandler",
  verify: "verifyHandler",
  post: "postHandler",
};

const entries = {};
for (const [name, file] of Object.entries(direct)) entries[name] = join(root, file);
for (const [name, exportName] of Object.entries(investigator)) {
  const file = join(entriesDir, `${name}.ts`);
  writeFileSync(file, `export { ${exportName} as handler } from "../../src/handlers/investigator.js";\n`);
  entries[name] = file;
}

let failed = false;
for (const [name, entry] of Object.entries(entries)) {
  const outfile = join(root, "build", "lambda", name, "index.mjs");
  try {
    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
      logLevel: "error",
    });
    console.log(`${name.padEnd(14)} ${(statSync(outfile).size / 1024).toFixed(0)} KiB`);
  } catch (e) {
    failed = true;
    console.error(`bundle ${name} failed: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
