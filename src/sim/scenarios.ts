import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { z } from "zod";
import { FAULTS } from "../chaos/flag.js";
import type { ScenarioDef } from "../chaos/chaos.js";
import { CATEGORIES } from "../core/types.js";

const ScenarioSchema = z.object({
  id: z.string().min(1),
  fault: z.enum(FAULTS),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
  durationSec: z.number().positive(),
  expectedCategory: z.enum(CATEGORIES),
  expectedAlarm: z.string().min(1),
});

/** Works from src/sim (tsx) and dist/sim (built): both sit two levels below the package root. */
export function defaultScenarioDir(): string {
  return fileURLToPath(new URL("../../scenarios/", import.meta.url));
}

export function loadScenarios(dir: string = defaultScenarioDir()): ScenarioDef[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const out = files.map((f) => ScenarioSchema.parse(JSON.parse(readFileSync(join(dir, f), "utf8"))) as ScenarioDef);
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function getScenario(id: string, dir?: string): ScenarioDef {
  const all = loadScenarios(dir);
  const s = all.find((x) => x.id === id);
  if (!s) throw new Error(`unknown scenario ${id}; try: ${all.map((x) => x.id).join(", ")}`);
  return s;
}
