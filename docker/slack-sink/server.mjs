// Dependency-free local stand-in for Slack: accepts chat.postMessage-shaped JSON and renders the Block Kit cards as HTML.
import http from "node:http";
import { pathToFileURL } from "node:url";

const MAX_BODY = 1024 * 1024;

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Escape first, then apply a tiny mrkdwn subset. Slack's own &lt; escapes are escaped again (visible as literal text, never as tags). */
export function mrkdwn(text) {
  return esc(text)
    .split(/(```[\s\S]*?```)/)
    .map((part) => {
      if (part.startsWith("```") && part.endsWith("```") && part.length >= 6) return `<pre>${part.slice(3, -3).replace(/^\n/, "").replace(/\n$/, "")}</pre>`;
      return part
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*([^*\n]+)\*/g, "<b>$1</b>")
        .replace(/\n/g, "<br>");
    })
    .join("");
}

function renderBlock(b) {
  if (!b || typeof b !== "object") return "";
  switch (b.type) {
    case "header":
      return `<h2>${esc(b.text?.text)}</h2>`;
    case "section":
      return `<div class=section>${mrkdwn(b.text?.text)}</div>`;
    case "context":
      return `<div class=ctx>${(b.elements ?? []).map((e) => mrkdwn(e?.text)).join(" ")}</div>`;
    case "actions":
      return `<div class=actions>${(b.elements ?? []).map((e) => `<button disabled>${esc(e?.text?.text)}</button>`).join(" ")}</div>`;
    case "divider":
      return "<hr>";
    default:
      return "";
  }
}

const CSS = `
:root{color-scheme:light dark;--bg:#f6f6f4;--card:#fff;--fg:#1c1c1a;--muted:#6b6b66;--line:#dcdcd6;--accent:#7a3cff}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--fg:#ececea;--muted:#9a9a94;--line:#33332f;--accent:#a98bff}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:720px;margin:0 auto}
h1{font-size:14px;color:var(--muted);font-weight:600;letter-spacing:.04em;text-transform:uppercase;margin:0 0 16px}
.card{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:8px;padding:12px 16px;margin:0 0 16px}
.card h2{font-size:17px;margin:4px 0 8px}
.meta{color:var(--muted);font-size:12px}
.section{margin:8px 0}.ctx{color:var(--muted);font-size:13px;margin:4px 0}
pre{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px;overflow:auto;font-size:12px}
code{background:var(--bg);border-radius:4px;padding:0 4px}
button{font:inherit;padding:4px 10px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--muted)}
`;

function page(messages) {
  const cards = messages.length
    ? messages
        .map(
          (m) =>
            `<article class=card><div class=meta>${esc(m.channel)} · ${esc(m.ts)} · ${esc(m.incidentId ?? "")}</div>${(m.blocks ?? []).map(renderBlock).join("")}</article>`,
        )
        .join("\n")
    : "<p class=meta>No messages yet. Run <code>rca demo ddb-throttle-40</code>.</p>";
  return `<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><title>rca-bot · Slack sink</title><style>${CSS}</style></head><body><main><h1>#incidents · local Slack sink</h1>${cards}</main></body></html>`;
}

export function createSinkServer() {
  const messages = [];
  let counter = 0;
  const json = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  return http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/health") return json(res, 200, { ok: true });
    if (req.method === "GET" && path === "/api/messages") return json(res, 200, { messages });
    if (req.method === "DELETE" && path === "/api/messages") {
      messages.length = 0;
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(page(messages));
    }
    if (req.method === "POST" && path === "/api/chat.postMessage") {
      let size = 0;
      const chunks = [];
      let aborted = false;
      req.on("data", (c) => {
        if (aborted) return;
        size += c.length;
        if (size > MAX_BODY) {
          aborted = true;
          json(res, 413, { ok: false, error: "too_large" });
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        if (aborted) return;
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return json(res, 400, { ok: false, error: "invalid_json" });
        }
        if (!body || typeof body !== "object") return json(res, 400, { ok: false, error: "invalid_json" });
        counter += 1;
        const ts = `${Math.floor(Date.now() / 1000)}.${String(counter).padStart(6, "0")}`;
        messages.unshift({
          ts,
          channel: typeof body.channel === "string" ? body.channel : "#incidents",
          incidentId: body.incidentId,
          text: body.text,
          blocks: Array.isArray(body.blocks) ? body.blocks : [],
          receivedAt: new Date().toISOString(),
        });
        json(res, 200, { ok: true, ts });
      });
      return;
    }
    json(res, 404, { ok: false, error: "not_found" });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8080);
  createSinkServer().listen(port, "0.0.0.0", () => console.log(`slack sink listening on ${port}`));
}
