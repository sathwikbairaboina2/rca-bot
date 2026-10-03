import { ModelError, type Model, type ModelRequest, type ModelResponse } from "./types.js";

export type ScriptItem = string | Error | ((req: ModelRequest) => string);

/** Deterministic test double: replays a script and records every request. */
export class ScriptedModel implements Model {
  readonly requests: ModelRequest[] = [];
  private readonly script: ScriptItem[];

  constructor(script: ScriptItem[], readonly id = "scripted") {
    this.script = [...script];
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    const item = this.script.shift();
    if (item === undefined) throw new ModelError("script exhausted");
    if (item instanceof Error) throw item;
    const text = typeof item === "function" ? item(req) : item;
    return {
      text,
      usage: { inputTokens: Math.ceil((req.system.length + req.user.length) / 4), outputTokens: Math.ceil(text.length / 4) },
      latencyMs: 0,
    };
  }
}
