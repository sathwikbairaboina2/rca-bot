import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SlackMessage } from "../slack/render.js";

export interface SlackPoster {
  readonly kind: "webhook" | "sink" | "file";
  post(msg: SlackMessage, incidentId: string): Promise<{ location: string }>;
}

export class WebhookPoster implements SlackPoster {
  readonly kind = "webhook" as const;
  constructor(private readonly url: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async post(msg: SlackMessage): Promise<{ location: string }> {
    const res = await this.fetchImpl(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg) });
    if (!res.ok) throw new Error(`slack webhook HTTP ${res.status}`);
    return { location: "slack webhook" };
  }
}

export class SinkPoster implements SlackPoster {
  readonly kind = "sink" as const;
  private readonly baseUrl: string;
  constructor(baseUrl = "http://localhost:5350", private readonly fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async post(msg: SlackMessage, incidentId: string): Promise<{ location: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/chat.postMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "#incidents", incidentId, text: msg.text, blocks: msg.blocks }),
    });
    if (!res.ok) throw new Error(`slack sink HTTP ${res.status}`);
    return { location: `${this.baseUrl}/` };
  }
}

export class FilePoster implements SlackPoster {
  readonly kind = "file" as const;
  constructor(private readonly dir: string) {}

  async post(msg: SlackMessage, incidentId: string): Promise<{ location: string }> {
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, `${incidentId}.json`);
    await writeFile(path, JSON.stringify({ incidentId, ...msg }, null, 2));
    return { location: path };
  }
}

/** SLACK_WEBHOOK_URL set -> webhook; else a healthy local sink -> sink; else files under .rca/slack. */
export async function choosePoster(opts: { env: NodeJS.ProcessEnv; cwd: string; fetchImpl?: typeof fetch; sinkUrl?: string }): Promise<SlackPoster> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const hook = opts.env.SLACK_WEBHOOK_URL;
  if (hook) return new WebhookPoster(hook, fetchImpl);
  const sinkUrl = (opts.sinkUrl ?? "http://localhost:5350").replace(/\/$/, "");
  try {
    const res = await fetchImpl(`${sinkUrl}/health`, { signal: AbortSignal.timeout(500) });
    if (res.ok) return new SinkPoster(sinkUrl, fetchImpl);
  } catch {
    // no sink running
  }
  return new FilePoster(join(opts.cwd, ".rca", "slack"));
}
