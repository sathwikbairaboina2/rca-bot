import { ModelError, type Model, type ModelRequest, type ModelResponse } from "./types.js";

export interface OllamaOptions {
  model: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  numCtx?: number;
}

export class OllamaModel implements Model {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly numCtx: number;

  constructor(private readonly o: OllamaOptions) {
    this.id = `ollama:${o.model}`;
    this.baseUrl = (o.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
    this.fetchImpl = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 600_000;
    this.numCtx = o.numCtx ?? 8192;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          model: this.o.model,
          stream: false,
          think: false,
          keep_alive: "30m",
          format: req.schema,
          options: { temperature: 0, num_ctx: this.numCtx, num_predict: req.maxOutputTokens },
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
        }),
      });
    } catch (e) {
      throw new ModelError(`ollama request failed: ${(e as Error).message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ModelError(`ollama HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const j = (await res.json()) as {
      error?: string;
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    if (j.error) throw new ModelError(`ollama error: ${j.error}`);
    return {
      text: j.message?.content ?? "",
      usage: { inputTokens: j.prompt_eval_count ?? 0, outputTokens: j.eval_count ?? 0 },
      latencyMs: Date.now() - started,
    };
  }
}
