import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { inlineCode } from "../../infra/lib/code.js";
import { DemoServiceStack } from "../../infra/lib/demo-service-stack.js";
import { allPolicyStatements } from "./support.js";

let t: Template;
beforeAll(() => {
  t = Template.fromStack(new DemoServiceStack(new App(), "RcaDemoService", { codeFor: inlineCode }));
});

describe("DemoServiceStack", () => {
  it("has the two alarms with a 3-of-3 minute rule", () => {
    t.resourceCountIs("AWS::CloudWatch::Alarm", 2);
    t.hasResourceProperties("AWS::CloudWatch::Alarm", { AlarmName: "orders-5xx-rate", Threshold: 0.05, EvaluationPeriods: 3, DatapointsToAlarm: 3, Period: 60 });
    t.hasResourceProperties("AWS::CloudWatch::Alarm", { AlarmName: "orders-p99-latency", Threshold: 2000, EvaluationPeriods: 3, DatapointsToAlarm: 3, ExtendedStatistic: "p99" });
  });
  it("sets the function timeouts", () => {
    t.hasResourceProperties("AWS::Lambda::Function", { FunctionName: "rca-demo-orders", Timeout: 6, Runtime: "nodejs22.x", Architectures: ["arm64"] });
    t.hasResourceProperties("AWS::Lambda::Function", { FunctionName: "rca-demo-payments", Timeout: 10 });
  });
  it("tags the chaos targets chaos:allowed=true", () => {
    const tag = Match.arrayWith([{ Key: "chaos:allowed", Value: "true" }]);
    t.hasResourceProperties("AWS::Lambda::Function", { FunctionName: "rca-demo-orders", Tags: tag });
    t.hasResourceProperties("AWS::Lambda::Function", { FunctionName: "rca-demo-payments", Tags: tag });
    t.hasResourceProperties("AWS::SSM::Parameter", { Name: "/rca-demo/chaos/active", Value: "{}", Tags: { "chaos:allowed": "true" } });
  });
  it("exposes one REST API and explicit log groups", () => {
    t.resourceCountIs("AWS::ApiGateway::RestApi", 1);
    t.hasResourceProperties("AWS::Logs::LogGroup", { LogGroupName: "/aws/lambda/rca-demo-orders", RetentionInDays: 7 });
  });
  it("uses no wildcard IAM actions", () => {
    const actions = allPolicyStatements(t).flatMap((s) => s.actions);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.filter((a) => a.includes("*"))).toEqual([]);
  });
});
