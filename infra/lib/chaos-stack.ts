import {
  Duration, Stack, aws_dynamodb as dynamodb, aws_events as events, aws_events_targets as targets, aws_iam as iam, aws_ssm as ssm,
  type StackProps,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { makeFunction, type CodeFor } from "./code.js";

export interface ChaosStackProps extends StackProps {
  codeFor: CodeFor;
  flagParam: ssm.IStringParameter;
  truthTable: dynamodb.ITableV2;
}

/** Fault injection with two safety rails: tag-scoped write access (I8) and a one-minute expiry sweep (I7). */
export class ChaosStack extends Stack {
  constructor(scope: Construct, id: string, props: ChaosStackProps) {
    super(scope, id, props);

    const chaos = makeFunction(this, "Chaos", props.codeFor, {
      name: "chaos", functionName: "rca-chaos", timeout: Duration.seconds(30),
      environment: { FLAG_PARAM: props.flagParam.parameterName, TABLE_NAME: props.truthTable.tableName },
    });

    chaos.addToRolePolicy(new iam.PolicyStatement({
      actions: ["ssm:PutParameter", "ssm:GetParameter"],
      resources: [props.flagParam.parameterArn],
      conditions: { StringEquals: { "aws:ResourceTag/chaos:allowed": "true" } },
    }));
    chaos.addToRolePolicy(new iam.PolicyStatement({ actions: ["ssm:ListTagsForResource"], resources: [props.flagParam.parameterArn] }));
    chaos.addToRolePolicy(new iam.PolicyStatement({ actions: ["dynamodb:PutItem"], resources: [props.truthTable.tableArn] }));

    const revert = new events.Rule(this, "Revert", {
      ruleName: "rca-chaos-revert",
      schedule: events.Schedule.rate(Duration.minutes(1)),
    });
    revert.addTarget(new targets.LambdaFunction(chaos, { event: events.RuleTargetInput.fromObject({ action: "revert-expired" }) }));
  }
}
