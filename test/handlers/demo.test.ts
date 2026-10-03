import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { APIGatewayProxyEvent } from "aws-lambda";
import { revertExpired, type FlagStore } from "../../src/chaos/chaos.js";
import { handleChaosEvent } from "../../src/handlers/chaos.js";
import { resetFlagCache } from "../../src/handlers/env.js";
import { handler as ordersHandler } from "../../src/handlers/orders.js";
import { handler as paymentsHandler } from "../../src/handlers/payments.js";

const event = (body: string | null) => ({ body }) as APIGatewayProxyEvent;
const order = { orderId: "o1", customerEmail: "a@example.com", quantity: 1, giftWrap: false, amountCents: 1000 };

describe("demo handlers", () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const lambda = mockClient(LambdaClient);
  const ssm = mockClient(SSMClient);
  beforeEach(() => {
    process.env.TABLE_NAME = "T";
    process.env.PAYMENTS_FUNCTION = "rca-demo-payments";
    process.env.FLAG_PARAM = "/rca-demo/chaos/active";
    resetFlagCache();
  });
  afterEach(() => { ddb.reset(); lambda.reset(); ssm.reset(); });

  it("orders rejects a malformed body with 400", async () => {
    expect((await ordersHandler(event("not json"))).statusCode).toBe(400);
    expect((await ordersHandler(event(JSON.stringify({ orderId: "x" })))).statusCode).toBe(400);
    expect((await ordersHandler(event(null))).statusCode).toBe(400);
  });

  it("orders returns 201 when healthy and writes the order", async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: "{}" } });
    lambda.on(InvokeCommand).resolves({ Payload: Buffer.from(JSON.stringify({ status: 200, latencyMs: 30 })) as never });
    ddb.on(PutCommand).resolves({});
    const res = await ordersHandler(event(JSON.stringify(order)), { awsRequestId: "r1" });
    expect(res.statusCode).toBe(201);
    expect(ddb.commandCalls(PutCommand)[0]!.args[0].input).toMatchObject({ TableName: "T", Item: { orderId: "o1" } });
  });

  it("orders maps a payments failure to 502", async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: "{}" } });
    lambda.on(InvokeCommand).resolves({ Payload: Buffer.from(JSON.stringify({ status: 503, latencyMs: 30 })) as never });
    expect((await ordersHandler(event(JSON.stringify(order)))).statusCode).toBe(502);
  });

  it("payments behaves as healthy when the flag read fails", async () => {
    ssm.on(GetParameterCommand).rejects(new Error("denied"));
    const out = await paymentsHandler({ orderId: "o1", amountCents: 100 });
    expect(out.status).toBe(200);
  });
});

describe("chaos handler", () => {
  const mem = () => {
    const values = new Map<string, string>();
    const flags: FlagStore = { getTags: async () => ({ "chaos:allowed": "true" }), put: async (n, v) => { values.set(n, v); }, get: async (n) => values.get(n) ?? null };
    return { values, deps: { flags, paramName: "p", truth: { putTruth: async () => {} } } };
  };
  const scenario = { id: "s", fault: "timeout", params: { rate: 0.3 }, durationSec: 60, expectedCategory: "TIMEOUT", expectedAlarm: "a" };

  it("rejects an invalid action with a validation error", async () => {
    await expect(handleChaosEvent({ action: "explode" }, mem().deps, 0)).rejects.toThrow();
  });
  it("starts, and the scheduled revert clears it after expiry (I7)", async () => {
    const m = mem();
    await handleChaosEvent({ action: "start", scenario }, m.deps, 1_000_000);
    expect(m.values.get("p")).toContain("\"timeout\"");
    expect(await handleChaosEvent({ action: "revert-expired" }, m.deps, 1_000_000 + 30_000)).toMatchObject({ reverted: false });
    expect(await handleChaosEvent({ action: "revert-expired" }, m.deps, 1_000_000 + 61_000)).toMatchObject({ reverted: true });
    expect(m.values.get("p")).toBe("{}");
    expect(await revertExpired({ ...m.deps, nowMs: 5_000_000 })).toEqual({ reverted: false });
  });
});
