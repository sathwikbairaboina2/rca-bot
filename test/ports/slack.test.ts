import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { choosePoster, FilePoster, SinkPoster, WebhookPoster } from "../../src/ports/slack.js";

const msg = { text: "t", blocks: [{ type: "divider" }] };
const ok = async () => new Response("{}", { status: 200 });

describe("posters", () => {
  it("webhook posts JSON and throws on 500", async () => {
    let seen: any;
    const f = (async (url: string, init: RequestInit) => { seen = { url, body: JSON.parse(init.body as string) }; return new Response("ok"); }) as unknown as typeof fetch;
    await new WebhookPoster("https://hooks.example/test", f).post(msg);
    expect(seen).toEqual({ url: "https://hooks.example/test", body: msg });
    await expect(new WebhookPoster("https://h", (async () => new Response("no", { status: 500 })) as unknown as typeof fetch).post(msg)).rejects.toThrow(/500/);
  });
  it("sink posts to /api/chat.postMessage", async () => {
    let url = "";
    let body: any;
    const f = (async (u: string, init: RequestInit) => { url = u; body = JSON.parse(init.body as string); return new Response("{}"); }) as unknown as typeof fetch;
    const r = await new SinkPoster("http://localhost:5350", f).post(msg, "inc-1");
    expect(url).toBe("http://localhost:5350/api/chat.postMessage");
    expect(body).toMatchObject({ channel: "#incidents", incidentId: "inc-1", text: "t" });
    expect(r.location).toBe("http://localhost:5350/");
  });
  it("file poster writes <dir>/<incidentId>.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rca-slack-"));
    const r = await new FilePoster(dir).post(msg, "inc-9");
    expect(JSON.parse(readFileSync(r.location, "utf8"))).toMatchObject({ incidentId: "inc-9", text: "t" });
  });
  it("choosePoster prefers webhook, then a healthy sink, then files", async () => {
    expect((await choosePoster({ env: { SLACK_WEBHOOK_URL: "https://h" }, cwd: "." })).kind).toBe("webhook");
    expect((await choosePoster({ env: {}, cwd: ".", fetchImpl: ok as unknown as typeof fetch })).kind).toBe("sink");
    const down = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect((await choosePoster({ env: {}, cwd: ".", fetchImpl: down })).kind).toBe("file");
  });
});
