import { FabricatorModel } from "./fabricator.js";
import { BedrockModel } from "./bedrock.js";
import { HeuristicModel } from "./heuristic.js";
import { OllamaModel } from "./ollama.js";
import type { Model } from "./types.js";

export function createModel(spec: string, env: NodeJS.ProcessEnv = process.env): Model {
  if (spec === "heuristic") return new HeuristicModel();
  if (spec === "fabricator") return new FabricatorModel(new HeuristicModel(), { seed: 1 });
  if (spec.startsWith("ollama:") && spec.length > 7) {
    return new OllamaModel({ model: spec.slice(7), ...(env.OLLAMA_BASE_URL ? { baseUrl: env.OLLAMA_BASE_URL } : {}) });
  }
  if (spec.startsWith("bedrock:") && spec.length > 8) return new BedrockModel({ modelId: spec.slice(8) });
  throw new Error(`unknown model spec ${spec}; use heuristic | ollama:<name> | bedrock:<modelId> | fabricator`);
}

/** File-name safe form of a model spec: "ollama:qwen3.8:27b" becomes "ollama-qwen3.8-27b". */
export function modelSlug(spec: string): string {
  return spec.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");
}
