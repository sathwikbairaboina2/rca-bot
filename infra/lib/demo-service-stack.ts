import {
  Duration, RemovalPolicy, Stack, Tags, aws_apigateway as apigw, aws_cloudwatch as cloudwatch, aws_dynamodb as dynamodb, aws_ssm as ssm,
  type StackProps,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { makeFunction, type CodeFor } from "./code.js";

export interface DemoServiceProps extends StackProps { codeFor: CodeFor }

/** The system under investigation: an orders API, a payments function, an orders table, a chaos flag and two alarms. */
export class DemoServiceStack extends Stack {
  readonly flagParam: ssm.StringParameter;
  readonly logGroupNames: string[];
  readonly alarmNames: string[];

  constructor(scope: Construct, id: string, props: DemoServiceProps) {
    super(scope, id, props);

    const table = new dynamodb.TableV2(this, "Orders", {
      tableName: "rca-demo-orders",
      partitionKey: { name: "orderId", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.flagParam = new ssm.StringParameter(this, "ChaosFlag", {
      parameterName: "/rca-demo/chaos/active",
      stringValue: "{}",
      description: "Chaos fault flag. {} means healthy. Expires on its own (rca-chaos-revert).",
    });

    const flagName = this.flagParam.parameterName;
    const payments = makeFunction(this, "Payments", props.codeFor, {
      name: "payments", functionName: "rca-demo-payments", timeout: Duration.seconds(10), environment: { FLAG_PARAM: flagName },
    });
    const orders = makeFunction(this, "OrdersFn", props.codeFor, {
      name: "orders", functionName: "rca-demo-orders", timeout: Duration.seconds(6),
      environment: { TABLE_NAME: table.tableName, PAYMENTS_FUNCTION: payments.functionName, FLAG_PARAM: flagName },
    });

    table.grant(orders, "dynamodb:PutItem");
    payments.grantInvoke(orders);
    this.flagParam.grantRead(orders);
    this.flagParam.grantRead(payments);

    const api = new apigw.RestApi(this, "Api", { restApiName: "rca-demo-orders-api", deployOptions: { stageName: "prod" } });
    api.root.addResource("orders").addMethod("POST", new apigw.LambdaIntegration(orders));

    const alarmProps = {
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    };
    new cloudwatch.Alarm(this, "Orders5xxRate", {
      alarmName: "orders-5xx-rate",
      metric: api.metricServerError({ period: Duration.minutes(1), statistic: "Average" }),
      threshold: 0.05,
      ...alarmProps,
    });
    new cloudwatch.Alarm(this, "OrdersP99Latency", {
      alarmName: "orders-p99-latency",
      metric: api.metricLatency({ period: Duration.minutes(1), statistic: "p99" }),
      threshold: 2000,
      ...alarmProps,
    });

    for (const target of [orders, payments, this.flagParam]) Tags.of(target).add("chaos:allowed", "true");

    this.logGroupNames = ["/aws/lambda/rca-demo-orders", "/aws/lambda/rca-demo-payments"];
    this.alarmNames = ["orders-5xx-rate", "orders-p99-latency"];
  }
}
