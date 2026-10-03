import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { activeFault, parseFlag, type FaultFlag } from "../chaos/flag.js";

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing environment variable ${name}`);
  return v;
}

/** Lazy, memoized clients: nothing is constructed at import time, so unit tests can mock them first. */
function lazy<T>(make: () => T): () => T {
  let v: T | undefined;
  return () => (v ??= make());
}
export const ddbDoc = lazy(() => DynamoDBDocumentClient.from(new DynamoDBClient({})));
export const s3Client = lazy(() => new S3Client({}));
export const ssmClient = lazy(() => new SSMClient({}));
export const lambdaClient = lazy(() => new LambdaClient({}));
export const logsClient = lazy(() => new CloudWatchLogsClient({}));
export const cwClient = lazy(() => new CloudWatchClient({}));

const FLAG_TTL_MS = 10_000;
let flagCache: { value: string | null; at: number } | null = null;

/** Reads the chaos flag from SSM, cached for 10 s, and applies the expiry rule (I7). */
export async function readActiveFault(nowMs: number = Date.now()): Promise<FaultFlag | null> {
  if (!flagCache || nowMs - flagCache.at > FLAG_TTL_MS) {
    try {
      const r = await ssmClient().send(new GetParameterCommand({ Name: requireEnv("FLAG_PARAM") }));
      flagCache = { value: r.Parameter?.Value ?? null, at: nowMs };
    } catch {
      // a broken flag read must never take the demo service down: behave as healthy
      flagCache = { value: null, at: nowMs };
    }
  }
  return activeFault(parseFlag(flagCache.value), nowMs);
}

export function resetFlagCache(): void {
  flagCache = null;
}
