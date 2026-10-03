import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { ModelError, type Model, type ModelRequest, type ModelResponse } from "./types.js";

export class BedrockModel implements Model {
  readonly id: string;
  private readonly client: BedrockRuntimeClient;

  constructor(private readonly o: { modelId: string; client?: BedrockRuntimeClient }) {
    this.id = `bedrock:${o.modelId}`;
    this.client = o.client ?? new BedrockRuntimeClient({});
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    let out;
    try {
      out = await this.client.send(
        new ConverseCommand({
          modelId: this.o.modelId,
          system: [{ text: req.system }],
          messages: [{ role: "user", content: [{ text: req.user }] }],
          inferenceConfig: { maxTokens: req.maxOutputTokens, temperature: 0 },
          toolConfig: {
            tools: [
              {
                toolSpec: {
                  name: "submit",
                  description: "Return the answer as structured JSON.",
                  inputSchema: { json: req.schema as never },
                },
              },
            ],
            toolChoice: { tool: { name: "submit" } },
          },
        }),
      );
    } catch (e) {
      throw new ModelError(`bedrock request failed: ${(e as Error).message}`);
    }
    const block = out.output?.message?.content?.find((c) => c.toolUse?.name === "submit");
    if (!block?.toolUse) throw new ModelError("bedrock returned no submit tool call");
    return {
      text: JSON.stringify(block.toolUse.input),
      usage: { inputTokens: out.usage?.inputTokens ?? 0, outputTokens: out.usage?.outputTokens ?? 0 },
      latencyMs: Date.now() - started,
    };
  }
}
