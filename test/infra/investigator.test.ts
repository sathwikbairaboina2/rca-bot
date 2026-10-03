import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { inlineCode } from "../../infra/lib/code.js";
import { InvestigatorStack } from "../../infra/lib/investigator-stack.js";
import { allPolicyStatements } from "./support.js";

const ALLOWED = new Set([
  "logs:StartQuery", "logs:GetQueryResults", "logs:StopQuery", "cloudwatch:GetMetricData", "cloudwatch:DescribeAlarms",
  "bedrock:InvokeModel", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query",
  "s3:GetObject", "s3:PutObject", "s3:ListBucket", "ssm:GetParameter", "lambda:InvokeFunction", "states:StartExecution",
]);
const STAR_ONLY_ACTIONS = new Set(["logs:GetQueryResults", "logs:StopQuery", "cloudwatch:GetMetricData", "cloudwatch:DescribeAlarms"]);

let t: Template;
beforeAll(() => {
  t = Template.fromStack(new InvestigatorStack(new App(), "RcaInvestigator", {
    codeFor: inlineCode,
    logGroupsByService: { orders: ["/aws/lambda/rca-demo-orders", "/aws/lambda/rca-demo-payments"] },
    alarmNames: ["orders-5xx-rate", "orders-p99-latency"],
    modelId: "anthropic.example-model-v1:0",
  }));
});

describe("InvestigatorStack", () => {
  it("grants only allowlisted actions and never a wildcard (I6)", () => {
    const stmts = allPolicyStatements(t);
    const actions = stmts.flatMap((s) => s.actions);
    expect(actions.filter((a) => a.includes("*"))).toEqual([]);
    expect(actions.filter((a) => !ALLOWED.has(a))).toEqual([]);
  });
  it("uses Resource * only for the four actions that require it", () => {
    for (const s of allPolicyStatements(t)) {
      if (s.resources.includes("*")) expect(s.actions.every((a) => STAR_ONLY_ACTIONS.has(a)), JSON.stringify(s)).toBe(true);
    }
  });
  it("defines the standard state machine with the expected states and a map concurrency of 3", () => {
    t.hasResourceProperties("AWS::StepFunctions::StateMachine", { StateMachineType: "STANDARD", StateMachineName: "rca-investigate" });
    const sm = Object.values(t.findResources("AWS::StepFunctions::StateMachine"))[0] as any;
    const def = JSON.stringify(sm.Properties.DefinitionString);
    for (const name of ["Dedupe", "GatherContext", "Plan", "RunQueries", "Hypothesize", "Verify", "Post"]) expect(def).toContain(name);
    expect(def).toContain("\\\"MaxConcurrency\\\":3");
  });
  it("routes only ALARM events for the demo alarms to the state machine", () => {
    t.hasResourceProperties("AWS::Events::Rule", {
      EventPattern: {
        source: ["aws.cloudwatch"],
        "detail-type": ["CloudWatch Alarm State Change"],
        detail: { state: { value: ["ALARM"] }, alarmName: ["orders-5xx-rate", "orders-p99-latency"] },
      },
    });
  });
  it("sets TTL and point-in-time recovery on the table and blocks public access on the bucket", () => {
    t.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
      Replicas: Match.arrayWith([Match.objectLike({ PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } })]),
    });
    t.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    });
  });
  it("creates the seven rca-inv functions", () => {
    for (const s of ["dedupe", "gatherContext", "plan", "runQuery", "hypothesize", "verify", "post"]) {
      t.hasResourceProperties("AWS::Lambda::Function", { FunctionName: `rca-inv-${s}` });
    }
  });
});
