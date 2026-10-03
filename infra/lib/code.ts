import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Duration, RemovalPolicy, aws_lambda as lambda, aws_logs as logs } from "aws-cdk-lib";
import type { Construct } from "constructs";

export type LambdaName = "orders" | "payments" | "chaos" | "dedupe" | "gatherContext" | "plan" | "runQuery" | "hypothesize" | "verify" | "post";
export type CodeFor = (name: LambdaName) => lambda.Code;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The esbuild output from `npm run bundle`. */
export const bundledCode: CodeFor = (name) => lambda.Code.fromAsset(join(repoRoot, "build", "lambda", name));

/** A stub for unit tests, so they never need the bundles. */
export const inlineCode: CodeFor = () => lambda.Code.fromInline("export const handler = async () => ({});");

export interface FunctionSpec {
  name: LambdaName;
  functionName: string;
  timeout: Duration;
  environment?: Record<string, string>;
}

/** Every function: Node 22, arm64, 256 MB, with an explicit one-week log group so the log group name is known. */
export function makeFunction(scope: Construct, id: string, codeFor: CodeFor, spec: FunctionSpec): lambda.Function {
  const logGroup = new logs.LogGroup(scope, `${id}Logs`, {
    logGroupName: `/aws/lambda/${spec.functionName}`,
    retention: logs.RetentionDays.ONE_WEEK,
    removalPolicy: RemovalPolicy.DESTROY,
  });
  return new lambda.Function(scope, id, {
    functionName: spec.functionName,
    runtime: lambda.Runtime.NODEJS_22_X,
    architecture: lambda.Architecture.ARM_64,
    handler: "index.handler",
    code: codeFor(spec.name),
    memorySize: 256,
    timeout: spec.timeout,
    environment: spec.environment ?? {},
    logGroup,
  });
}
