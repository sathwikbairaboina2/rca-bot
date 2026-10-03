import { App, Stack, aws_dynamodb as dynamodb } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { ChaosStack } from "../../infra/lib/chaos-stack.js";
import { inlineCode } from "../../infra/lib/code.js";
import { DemoServiceStack } from "../../infra/lib/demo-service-stack.js";
import { allPolicyStatements } from "./support.js";

let t: Template;
beforeAll(() => {
  const app = new App();
  const demo = new DemoServiceStack(app, "RcaDemoService", { codeFor: inlineCode });
  const dataStack = new Stack(app, "Data");
  const table = new dynamodb.TableV2(dataStack, "T", { partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING } });
  t = Template.fromStack(new ChaosStack(app, "RcaChaos", { codeFor: inlineCode, flagParam: demo.flagParam, truthTable: table }));
});

describe("ChaosStack", () => {
  it("sweeps expired faults every minute (I7)", () => {
    t.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "rate(1 minute)",
      Targets: Match.arrayWith([Match.objectLike({ Input: JSON.stringify({ action: "revert-expired" }) })]),
    });
  });
  it("only lets the chaos function write parameters tagged chaos:allowed=true (I8)", () => {
    const put = allPolicyStatements(t).find((s) => s.actions.includes("ssm:PutParameter"));
    expect(put).toBeDefined();
    expect(put!.conditions).toEqual({ StringEquals: { "aws:ResourceTag/chaos:allowed": "true" } });
    expect(allPolicyStatements(t).some((s) => s.actions.includes("ssm:ListTagsForResource"))).toBe(true);
  });
  it("uses no wildcard IAM actions", () => {
    expect(allPolicyStatements(t).flatMap((s) => s.actions).filter((a) => a.includes("*"))).toEqual([]);
  });
});
