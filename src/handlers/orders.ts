import { InvokeCommand } from "@aws-sdk/client-lambda";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from "aws-lambda";
import { z } from "zod";
import { createLogger } from "../demo/logger.js";
import { handleOrder } from "../demo/orders.js";
import { ddbDoc, lambdaClient, readActiveFault, requireEnv } from "./env.js";

const OrderSchema = z.object({
  orderId: z.string().min(1),
  customerEmail: z.string(),
  quantity: z.number().int(),
  giftWrap: z.boolean(),
  amountCents: z.number().int().nonnegative(),
});

const json = (statusCode: number, body: unknown): APIGatewayProxyResult => ({ statusCode, body: JSON.stringify(body) });

export async function handler(event: APIGatewayProxyEvent, context?: Pick<Context, "awsRequestId">): Promise<APIGatewayProxyResult> {
  let parsed;
  try {
    parsed = OrderSchema.safeParse(JSON.parse(event.body ?? ""));
  } catch {
    return json(400, { error: "body must be JSON" });
  }
  if (!parsed.success) return json(400, { error: "invalid order" });

  const version = process.env.AWS_LAMBDA_FUNCTION_VERSION ?? "$LATEST";
  const log = createLogger({
    service: "orders", functionVersion: version, requestId: context?.awsRequestId ?? "local", now: Date.now, sink: (l) => console.log(l),
  });
  const out = await handleOrder(parsed.data, {
    log,
    rng: Math.random,
    // Real time passes in Lambda, so the simulated clock's advance is a no-op here.
    clock: { now: Date.now, advance: () => {} },
    fault: await readActiveFault(),
    functionVersion: version,
    putOrder: async (o) => {
      await ddbDoc().send(new PutCommand({ TableName: requireEnv("TABLE_NAME"), Item: { ...o, createdAt: new Date().toISOString() } }));
    },
    callPayments: async (r) => {
      const res = await lambdaClient().send(new InvokeCommand({ FunctionName: requireEnv("PAYMENTS_FUNCTION"), Payload: Buffer.from(JSON.stringify(r)) }));
      const text = res.Payload ? Buffer.from(res.Payload).toString("utf8") : "{}";
      const body = JSON.parse(text) as { status?: number; latencyMs?: number };
      return { status: body.status ?? 502, latencyMs: body.latencyMs ?? 0 };
    },
  });
  return json(out.statusCode, { orderId: parsed.data.orderId, statusCode: out.statusCode });
}
