import { describe, expect, it } from "vitest";
import { OllamaModel } from "../../src/model/ollama.js";
import { ModelError, type ModelRequest } from "../../src/model/types.js";

const req: ModelRequest = { purpose: "plan", system: "sys", user: "usr", schema: { type: "object" }, maxOutputTokens: 123 };
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("OllamaModel", () => {
  it("sends the structured-output request and maps the response", async () => {
    let seen: any;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(init.body as string) };
      return jsonRes({ message: { content: "{\"queries\":[]}" }, prompt_eval_count: 10, eval_count: 4 });
    }) as unknown as typeof fetch;
    const m = new OllamaModel({ model: "qwen3.8:27b", baseUrl: "http://x:1/", fetch: fetchImpl });
    const out = await m.complete(req);
    expect(m.id).toBe("ollama:qwen3.8:27b");
    expect(seen.url).toBe("http://x:1/api/chat");
    expect(seen.body).toMatchObject({ think: false, stream: false, format: { type: "object" }, options: { num_predict: 123, temperature: 0 } });
    expect(out).toMatchObject({ text: "{\"queries\":[]}", usage: { inputTokens: 10, outputTokens: 4 } });
  });
  it("turns HTTP errors, error bodies and network failures into ModelError", async () => {
    const mk = (f: unknown) => new OllamaModel({ model: "m", fetch: f as typeof fetch });
    await expect(mk(async () => new Response("boom", { status: 500 })).complete(req)).rejects.toThrow(/HTTP 500/);
    await expect(mk(async () => jsonRes({ error: "model not found" })).complete(req)).rejects.toBeInstanceOf(ModelError);
    await expect(mk(async () => { throw new Error("ECONNREFUSED"); }).complete(req)).rejects.toBeInstanceOf(ModelError);
  });
});
