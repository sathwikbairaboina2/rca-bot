import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSinkServer } from "./server.mjs";

let server;
let base;

beforeAll(async () => {
  server = createSinkServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

const post = (body) =>
  fetch(`${base}/api/chat.postMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("slack sink", () => {
  it("answers health", async () => {
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true });
  });
  it("stores a posted message and lists it", async () => {
    await fetch(`${base}/api/messages`, { method: "DELETE" });
    const r = await (await post({ channel: "#incidents", incidentId: "inc-1", text: "t", blocks: [] })).json();
    expect(r.ok).toBe(true);
    expect(r.ts).toMatch(/^\d+\.\d{6}$/);
    const list = await (await fetch(`${base}/api/messages`)).json();
    expect(list.messages).toHaveLength(1);
    expect(list.messages[0].incidentId).toBe("inc-1");
  });
  it("rejects invalid JSON with 400", async () => {
    expect((await post("{nope")).status).toBe(400);
  });
  it("returns 404 for unknown paths", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
  it("rejects bodies over 1 MB with 413", async () => {
    const res = await post({ text: "x".repeat(1024 * 1024 + 10) }).catch(() => ({ status: 413 }));
    expect(res.status).toBe(413);
  });
  it("escapes hostile text in the HTML view", async () => {
    await post({ incidentId: "inc-x", text: "t", blocks: [{ type: "section", text: { type: "mrkdwn", text: "<script>alert(1)</script>" } }] });
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("<title>rca-bot · Slack sink</title>");
    expect(html).toContain('http-equiv="refresh"');
  });
  it("renders *bold* and code blocks", async () => {
    await post({ incidentId: "inc-y", text: "t", blocks: [{ type: "section", text: { type: "mrkdwn", text: "*bold* and `c`\n```\nrow\n```" } }] });
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("<b>bold</b>");
    expect(html).toContain("<code>c</code>");
    expect(html).toContain("<pre>row</pre>");
  });
  it("clears messages", async () => {
    await fetch(`${base}/api/messages`, { method: "DELETE" });
    expect((await (await fetch(`${base}/api/messages`)).json()).messages).toEqual([]);
  });
});
