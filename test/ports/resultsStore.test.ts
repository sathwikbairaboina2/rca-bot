import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, it } from "vitest";
import type { QueryResult } from "../../src/core/types.js";
import { MemoryResultsStore, S3ResultsStore } from "../../src/ports/resultsStore.js";

const res = (queryId: string): QueryResult => ({
  queryId, templateId: "t", logGroups: ["g"], window: { startMs: 0, endMs: 1 }, queryString: "q", status: "Complete", rows: [{ a: queryId }], bytesScanned: 0, truncated: false,
});

describe("MemoryResultsStore", () => {
  it("round-trips in query order", async () => {
    const s = new MemoryResultsStore();
    await s.put("inc-1", res("q10"));
    await s.put("inc-1", res("q2"));
    expect((await s.list("inc-1")).map((r) => r.queryId)).toEqual(["q2", "q10"]);
    expect(await s.list("inc-2")).toEqual([]);
  });
});

describe("S3ResultsStore", () => {
  const s3 = mockClient(S3Client);
  afterEach(() => s3.reset());

  it("puts JSON under incidents/<id>/<queryId>.json", async () => {
    s3.on(PutObjectCommand).resolves({});
    const key = await new S3ResultsStore(new S3Client({}), "b").put("inc-1", res("q1"));
    expect(key).toBe("incidents/inc-1/q1.json");
    expect(s3.commandCalls(PutObjectCommand)[0]!.args[0].input).toMatchObject({ Bucket: "b", Key: "incidents/inc-1/q1.json", ContentType: "application/json" });
  });
  it("lists and sorts q10 after q2", async () => {
    s3.on(ListObjectsV2Command).resolves({ Contents: [{ Key: "incidents/inc-1/q10.json" }, { Key: "incidents/inc-1/q2.json" }] });
    s3.on(GetObjectCommand).callsFake(async (input: { Key: string }) => {
      const id = input.Key.split("/").pop()!.replace(".json", "");
      return { Body: { transformToString: async () => JSON.stringify(res(id)) } };
    });
    const out = await new S3ResultsStore(new S3Client({}), "b").list("inc-1");
    expect(out.map((r) => r.queryId)).toEqual(["q2", "q10"]);
  });
});
