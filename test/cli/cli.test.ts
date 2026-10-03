import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/main.js";
import type { CliIo } from "../../src/cli/io.js";

function mkIo(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    cwd,
    env: {},
    fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch,
    now: () => Date.UTC(2026, 9, 3, 10, 0),
  };
  return { io, out: () => out.join("\n"), err: () => err.join("\n") };
}

describe("rca cli", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rca-cli-"));

  it("catalog lint passes", async () => {
    const t = mkIo(cwd);
    expect(await runCli(["catalog", "lint"], t.io)).toBe(0);
    expect(t.out().trim().endsWith("8 templates OK")).toBe(true);
  });

  describe("demo", () => {
    let code = -1;
    let out = "";
    beforeAll(async () => {
      const t = mkIo(cwd);
      code = await runCli(["demo", "ddb-throttle-40", "--model", "heuristic"], t.io);
      out = t.out();
    }, 60_000);

    it("explains the root cause and writes the report and card", () => {
      expect(code).toBe(0);
      expect(out).toContain("DEPENDENCY_THROTTLING");
      expect(out).toContain("confidence");
      expect(out).toContain("Card posted to");
      expect(readdirSync(join(cwd, ".rca", "incidents"))).toHaveLength(1);
      expect(readdirSync(join(cwd, ".rca", "slack"))).toHaveLength(1);
    });

    it("incident show --latest prints it again", async () => {
      const t = mkIo(cwd);
      expect(await runCli(["incident", "show", "--latest"], t.io)).toBe(0);
      expect(t.out()).toContain("DEPENDENCY_THROTTLING");
    });

    it("incident show --raw prints JSON and a missing id exits 1", async () => {
      const t = mkIo(cwd);
      expect(await runCli(["incident", "show", "--latest", "--raw"], t.io)).toBe(0);
      expect(JSON.parse(t.out()).status).toBe("POSTED");
      const t2 = mkIo(cwd);
      expect(await runCli(["incident", "show", "inc-missing"], t2.io)).toBe(1);
    });
  });

  it("demo --json prints only JSON", async () => {
    const t = mkIo(mkdtempSync(join(tmpdir(), "rca-cli-")));
    expect(await runCli(["demo", "cold-start-storm", "--json"], t.io)).toBe(0);
    expect(JSON.parse(t.out()).posted[0].category).toBe("COLD_START_STORM");
  }, 60_000);

  it("unknown scenario exits 2", async () => {
    const t = mkIo(cwd);
    expect(await runCli(["demo", "nope"], t.io)).toBe(2);
    expect(t.err()).toContain("unknown scenario");
  });

  it("chaos list shows all five scenarios", async () => {
    const t = mkIo(cwd);
    expect(await runCli(["chaos", "list"], t.io)).toBe(0);
    for (const id of ["ddb-throttle-40", "payments-5xx-50", "payments-timeout-30", "bad-deploy-v18", "cold-start-storm"]) expect(t.out()).toContain(id);
  });

  it("help returns 0 and an unknown command returns 2", async () => {
    const t = mkIo(cwd);
    expect(await runCli([], t.io)).toBe(0);
    expect(t.out()).toContain("Usage:");
    expect(await runCli(["bogus"], mkIo(cwd).io)).toBe(2);
    expect(existsSync(cwd)).toBe(true);
  });
});
