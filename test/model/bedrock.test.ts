import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, it } from "vitest";
import { BedrockModel } from "../../src/model/bedrock.js";
import { ModelError, type ModelRequest } from "../../src/model/types.js";

const req: ModelRequest = { purpose: "hypothesize", system: "s", user: "u", schema: { type: "object" }, maxOutputTokens: 50 };

describe("BedrockModel", () => {
  const br = mockClient(BedrockRuntimeClient);
  afterEach(() => br.reset());

  it("forces the submit tool and returns its input as JSON", async () => {
    br.on(ConverseCommand).resolves({
      output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: "1", name: "submit", input: { hypotheses: [] } } }] } },
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    });
    const m = new BedrockModel({ modelId: "some.model", client: new BedrockRuntimeClient({}) });
    const out = await m.complete(req);
    const input = br.commandCalls(ConverseCommand)[0]!.args[0].input;
    expect(input.toolConfig!.toolChoice).toEqual({ tool: { name: "submit" } });
    expect((input.toolConfig!.tools![0] as any).toolSpec.inputSchema.json).toEqual({ type: "object" });
    expect(out.text).toBe("{\"hypotheses\":[]}");
    expect(out.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    expect(m.id).toBe("bedrock:some.model");
  });
  it("errors when the model returns text only", async () => {
    br.on(ConverseCommand).resolves({ output: { message: { role: "assistant", content: [{ text: "hello" }] } } });
    await expect(new BedrockModel({ modelId: "m", client: new BedrockRuntimeClient({}) }).complete(req)).rejects.toBeInstanceOf(ModelError);
  });
});
