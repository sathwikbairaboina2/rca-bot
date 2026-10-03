import type { Usage } from "../core/types.js";

export interface ModelRequest {
  purpose: "plan" | "hypothesize";
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxOutputTokens: number;
}
export interface ModelResponse { text: string; usage: Usage; latencyMs: number }
export interface Model {
  readonly id: string;
  complete(req: ModelRequest): Promise<ModelResponse>;
}
export class ModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelError";
  }
}
