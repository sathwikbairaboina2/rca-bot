import type { Context } from "aws-lambda";
import { createLogger } from "../demo/logger.js";
import { handleCharge } from "../demo/payments.js";
import { readActiveFault } from "./env.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Direct invoke from the orders function: { orderId, amountCents } -> { status, latencyMs }. */
export async function handler(event: { orderId: string; amountCents: number }, context?: Pick<Context, "awsRequestId">) {
  const log = createLogger({
    service: "payments", functionVersion: process.env.AWS_LAMBDA_FUNCTION_VERSION ?? "$LATEST",
    requestId: context?.awsRequestId ?? "local", now: Date.now, sink: (l) => console.log(l),
  });
  const out = await handleCharge(event, { log, rng: Math.random, fault: await readActiveFault() });
  // Make the injected latency real so the caller genuinely waits (and can genuinely time out).
  await sleep(out.latencyMs);
  return out;
}
