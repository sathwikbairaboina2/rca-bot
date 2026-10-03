import { describe, expect, it } from "vitest";
import { BedrockModel } from "../../src/model/bedrock.js";
import { createModel, modelSlug } from "../../src/model/factory.js";
import { FabricatorModel } from "../../src/model/fabricator.js";
import { HeuristicModel } from "../../src/model/heuristic.js";
import { OllamaModel } from "../../src/model/ollama.js";

describe("createModel", () => {
  it("builds each kind", () => {
    expect(createModel("heuristic")).toBeInstanceOf(HeuristicModel);
    const o = createModel("ollama:qwen3.8:27b", {});
    expect(o).toBeInstanceOf(OllamaModel);
    expect(o.id).toBe("ollama:qwen3.8:27b");
    expect(createModel("bedrock:some.model-v1:0")).toBeInstanceOf(BedrockModel);
    const f = createModel("fabricator");
    expect(f).toBeInstanceOf(FabricatorModel);
    expect(f.id).toBe("fabricator(heuristic)");
  });
  it("rejects unknown specs", () => {
    expect(() => createModel("gpt")).toThrow(/unknown model spec gpt/);
    expect(() => createModel("ollama:")).toThrow();
  });
  it("makes file-safe slugs", () => {
    expect(modelSlug("ollama:qwen3.8:27b")).toBe("ollama-qwen3.8-27b");
    expect(modelSlug("heuristic")).toBe("heuristic");
  });
});
