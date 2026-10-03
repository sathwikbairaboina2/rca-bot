import { CloudWatchLogsClient, GetQueryResultsCommand, StartQueryCommand, StopQueryCommand } from "@aws-sdk/client-cloudwatch-logs";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, it } from "vitest";
import type { PlannedQuery } from "../../src/core/types.js";
import { CloudWatchQueryRunner, FixtureQueryRunner } from "../../src/ports/queryRunner.js";
import { jsonEvent } from "../support/fixtures.js";

const G = "/aws/lambda/x";
const q = (over: Partial<PlannedQuery> = {}): PlannedQuery => ({
  queryId: "q1", templateId: "errors_by_message", logGroups: [G], window: { startMs: 1000, endMs: 5000 }, queryString: "fields @message", ...over,
});

describe("FixtureQueryRunner", () => {
  it("filters by log group and window (end exclusive)", async () => {
    const events = [jsonEvent(1000, G, { a: 1 }), jsonEvent(4999, G, { a: 2 }), jsonEvent(5000, G, { a: 3 }), jsonEvent(2000, "/other", { a: 4 })];
    const r = await new FixtureQueryRunner(events).run(q());
    expect(r.status).toBe("Complete");
    expect(r.rows).toHaveLength(2);
    expect(r.bytesScanned).toBeGreaterThan(0);
  });
  it("truncates to maxRows", async () => {
    const events = Array.from({ length: 5 }, (_, i) => jsonEvent(1000 + i, G, { a: i }));
    const r = await new FixtureQueryRunner(events, { maxRows: 2 }).run(q());
    expect(r.truncated).toBe(true);
    expect(r.rows).toHaveLength(2);
  });
  it("reports a bad query as Failed without throwing", async () => {
    const r = await new FixtureQueryRunner([]).run(q({ queryString: "display x" }));
    expect(r.status).toBe("Failed");
    expect(r.error).toBeTruthy();
  });
});

describe("CloudWatchQueryRunner", () => {
  const cw = mockClient(CloudWatchLogsClient);
  afterEach(() => cw.reset());
  const sleep = async () => {};

  it("polls until Complete, maps rows and drops @ptr", async () => {
    cw.on(StartQueryCommand).resolves({ queryId: "abc" });
    cw.on(GetQueryResultsCommand)
      .resolvesOnce({ status: "Running" })
      .resolves({ status: "Complete", results: [[{ field: "@ptr", value: "p" }, { field: "n", value: "3" }]], statistics: { bytesScanned: 42 } });
    const r = await new CloudWatchQueryRunner(new CloudWatchLogsClient({}), { sleep }).run(q());
    expect(r).toMatchObject({ status: "Complete", rows: [{ n: "3" }], bytesScanned: 42, truncated: false });
    expect(cw.commandCalls(StartQueryCommand)[0]!.args[0].input).toMatchObject({ startTime: 1, endTime: 5, logGroupNames: [G], limit: 51 });
  });
  it("stops a query that runs too long", async () => {
    cw.on(StartQueryCommand).resolves({ queryId: "abc" });
    cw.on(GetQueryResultsCommand).resolves({ status: "Running" });
    cw.on(StopQueryCommand).resolves({});
    let t = 0;
    const r = await new CloudWatchQueryRunner(new CloudWatchLogsClient({}), { sleep: async () => { t += 10_000; }, now: () => t }).run(q());
    expect(r.status).toBe("Timeout");
    expect(cw.commandCalls(StopQueryCommand)).toHaveLength(1);
  });
  it("maps a StartQuery error to Failed", async () => {
    cw.on(StartQueryCommand).rejects(new Error("AccessDenied"));
    const r = await new CloudWatchQueryRunner(new CloudWatchLogsClient({}), { sleep }).run(q());
    expect(r).toMatchObject({ status: "Failed", error: "AccessDenied" });
  });
  it("maps a non-Complete terminal status to Failed", async () => {
    cw.on(StartQueryCommand).resolves({ queryId: "abc" });
    cw.on(GetQueryResultsCommand).resolves({ status: "Cancelled" });
    expect((await new CloudWatchQueryRunner(new CloudWatchLogsClient({}), { sleep }).run(q())).status).toBe("Failed");
  });
});
