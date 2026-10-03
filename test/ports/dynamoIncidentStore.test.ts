import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DynamoIncidentStore } from "../../src/ports/dynamoIncidentStore.js";

const NOW = Date.UTC(2026, 9, 3, 10, 0);
const meta = { incidentId: "inc-1", service: "orders", alarms: ["a1"], openedAtMs: NOW, status: "INVESTIGATING" as const };
const named = (name: string, extra: object = {}) => Object.assign(new Error(name), { name }, extra);

let ddb: ReturnType<typeof mockClient>;
let store: DynamoIncidentStore;
beforeEach(() => {
  ddb = mockClient(DynamoDBDocumentClient);
  store = new DynamoIncidentStore({ doc: DynamoDBDocumentClient.from(new DynamoDBClient({})), tableName: "T", now: () => NOW });
});
afterEach(() => ddb.restore());

describe("DynamoIncidentStore", () => {
  it("opens an incident with one 3-item transaction", async () => {
    ddb.on(TransactWriteCommand).resolves({});
    expect(await store.openIncident(meta, { nowMs: NOW, windowMs: 600_000, queriesAllowed: 6 })).toEqual({ opened: true });
    const input = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input;
    expect(input.TransactItems).toHaveLength(3);
    const first = input.TransactItems![0]!.Put!;
    expect(first.ConditionExpression).toBe("attribute_not_exists(pk) OR expiresAt < :nowSec");
    expect(first.Item).toMatchObject({ pk: "SVC#orders", sk: "OPEN", expiresAt: (NOW + 600_000) / 1000 });
  });
  it("returns the existing incident when the condition fails", async () => {
    ddb.on(TransactWriteCommand).rejects(
      named("TransactionCanceledException", { CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }, { Code: "None" }] }),
    );
    ddb.on(GetCommand).resolves({ Item: { incidentId: "inc-a" } });
    expect(await store.openIncident(meta, { nowMs: NOW, windowMs: 600_000, queriesAllowed: 6 })).toEqual({ opened: false, incidentId: "inc-a" });
  });
  it("rethrows other transaction failures", async () => {
    ddb.on(TransactWriteCommand).rejects(named("ThrottlingException"));
    await expect(store.openIncident(meta, { nowMs: NOW, windowMs: 1, queriesAllowed: 6 })).rejects.toThrow();
  });
  it("consumeQueries grants the remainder with a conditional update", async () => {
    ddb.on(GetCommand).resolves({ Item: { queriesUsed: 4, queriesAllowed: 6 } });
    ddb.on(UpdateCommand).resolves({});
    expect(await store.consumeQueries("inc-1", 5)).toBe(2);
    const input = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.ExpressionAttributeValues).toMatchObject({ ":new": 6, ":seen": 4 });
    expect(input.ConditionExpression).toBe("queriesUsed = :seen");
  });
  it("consumeQueries retries after a lost race and sees the budget spent", async () => {
    ddb.on(GetCommand).resolvesOnce({ Item: { queriesUsed: 4, queriesAllowed: 6 } }).resolves({ Item: { queriesUsed: 6, queriesAllowed: 6 } });
    ddb.on(UpdateCommand).rejectsOnce(named("ConditionalCheckFailedException"));
    expect(await store.consumeQueries("inc-1", 5)).toBe(0);
  });
  it("reserveDailyTokens maps the conditional failure to false", async () => {
    ddb.on(UpdateCommand).rejectsOnce(named("ConditionalCheckFailedException")).resolves({});
    expect(await store.reserveDailyTokens("2026-10-03", 100, 1000)).toBe(false);
    expect(await store.reserveDailyTokens("2026-10-03", 100, 1000)).toBe(true);
    expect(ddb.commandCalls(UpdateCommand)[1]!.args[0].input.ExpressionAttributeValues).toMatchObject({ ":n": 100, ":limit": 900 });
  });
  it("getIncident maps META and BUDGET", async () => {
    ddb.on(QueryCommand).resolves({
      Items: [
        { pk: "INC#inc-1", sk: "BUDGET", queriesAllowed: 6, queriesUsed: 2, bytesScanned: 10, tokensIn: 5, tokensOut: 1 },
        { pk: "INC#inc-1", sk: "META", service: "orders", alarms: ["a1", "a2"], openedAt: new Date(NOW).toISOString(), status: "POSTED" },
      ],
    });
    expect(await store.getIncident("inc-1")).toEqual({
      meta: { incidentId: "inc-1", service: "orders", alarms: ["a1", "a2"], openedAtMs: NOW, status: "POSTED" },
      budget: { queriesAllowed: 6, queriesUsed: 2, bytesScanned: 10, tokensIn: 5, tokensOut: 1 },
    });
    ddb.on(QueryCommand).resolves({ Items: [] });
    expect(await store.getIncident("x")).toBeNull();
  });
});
