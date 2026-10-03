import { describe, expect, it } from "vitest";
import { ScriptedModel } from "../../src/model/scripted.js";
import type { ModelRequest } from "../../src/model/types.js";

const req = (user: string): ModelRequest => ({ purpose: "plan", system: "s", user, schema: {}, maxOutputTokens: 1 });

describe("ScriptedModel", () => {
  it("replays in order, throws errors, records requests and runs out", async () => {
    const m = new ScriptedModel(["a", new Error("boom"), (r) => `echo:${r.user}`]);
    expect((await m.complete(req("1"))).text).toBe("a");
    await expect(m.complete(req("2"))).rejects.toThrow("boom");
    expect((await m.complete(req("3"))).text).toBe("echo:3");
    await expect(m.complete(req("4"))).rejects.toThrow("script exhausted");
    expect(m.requests.map((r) => r.user)).toEqual(["1", "2", "3", "4"]);
  });
});
