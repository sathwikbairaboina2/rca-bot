import {
  ArnFormat, Duration, RemovalPolicy, Stack, aws_dynamodb as dynamodb, aws_events as events, aws_events_targets as targets, aws_iam as iam,
  aws_lambda as lambda, aws_s3 as s3, aws_stepfunctions as sfn, aws_stepfunctions_tasks as tasks, type StackProps,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { makeFunction, type CodeFor, type LambdaName } from "./code.js";

export interface InvestigatorProps extends StackProps {
  codeFor: CodeFor;
  logGroupsByService: Record<string, string[]>;
  alarmNames: string[];
  modelId: string;
  slackWebhookParamName?: string;
}

type Step = "dedupe" | "gatherContext" | "plan" | "runQuery" | "hypothesize" | "verify" | "post";

/** EventBridge alarm event -> Step Functions -> seven least-privilege Lambdas (I6). */
export class InvestigatorStack extends Stack {
  readonly table: dynamodb.TableV2;
  readonly bucket: s3.Bucket;
  readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: InvestigatorProps) {
    super(scope, id, props);
    const webhookParam = props.slackWebhookParamName ?? "/rca-bot/slack-webhook";

    this.table = new dynamodb.TableV2(this, "Incidents", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: "expiresAt",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.bucket = new s3.Bucket(this, "Artifacts", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [{ expiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const env = {
      TABLE_NAME: this.table.tableName,
      BUCKET_NAME: this.bucket.bucketName,
      MODEL_SPEC: `bedrock:${props.modelId}`,
      LOG_GROUPS_BY_SERVICE: JSON.stringify(props.logGroupsByService),
      SLACK_WEBHOOK_PARAM: webhookParam,
      QUERIES_ALLOWED: "6",
      DAILY_TOKEN_CAP: "2000000",
    };
    const fn = (step: Step, timeoutSec: number): lambda.Function =>
      makeFunction(this, `Fn${step}`, props.codeFor, {
        name: step as LambdaName, functionName: `rca-inv-${step}`, timeout: Duration.seconds(timeoutSec), environment: env,
      });
    const f = {
      dedupe: fn("dedupe", 60), gatherContext: fn("gatherContext", 60), plan: fn("plan", 120), runQuery: fn("runQuery", 60),
      hypothesize: fn("hypothesize", 120), verify: fn("verify", 60), post: fn("post", 60),
    };

    const allow = (fnc: lambda.Function, actions: string[], resources: string[]) =>
      fnc.addToRolePolicy(new iam.PolicyStatement({ actions, resources }));
    const tableArn = this.table.tableArn;
    const bucketArn = this.bucket.bucketArn;
    const objects = `${bucketArn}/incidents/*`;
    const modelArn = this.formatArn({ service: "bedrock", account: "", resource: "foundation-model", resourceName: props.modelId });
    const webhookArn = this.formatArn({ service: "ssm", resource: "parameter", resourceName: webhookParam.replace(/^\//, "") });
    const logGroupArns = [...new Set(Object.values(props.logGroupsByService).flat())].map((name) =>
      this.formatArn({ service: "logs", resource: "log-group", resourceName: `${name}:*`, arnFormat: ArnFormat.COLON_RESOURCE_NAME }),
    );

    allow(f.dedupe, ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:GetItem"], [tableArn]);
    // Metric reads cannot be scoped to a resource: GetMetricData and DescribeAlarms only support "*".
    allow(f.gatherContext, ["cloudwatch:DescribeAlarms", "cloudwatch:GetMetricData"], ["*"]);
    allow(f.plan, ["bedrock:InvokeModel"], [modelArn]);
    allow(f.plan, ["dynamodb:GetItem", "dynamodb:UpdateItem"], [tableArn]);
    allow(f.runQuery, ["logs:StartQuery"], logGroupArns);
    // GetQueryResults and StopQuery are authorised against the query id, not a log group.
    allow(f.runQuery, ["logs:GetQueryResults", "logs:StopQuery"], ["*"]);
    allow(f.runQuery, ["s3:PutObject"], [objects]);
    allow(f.hypothesize, ["bedrock:InvokeModel"], [modelArn]);
    allow(f.hypothesize, ["s3:GetObject"], [objects]);
    allow(f.hypothesize, ["s3:ListBucket"], [bucketArn]);
    allow(f.hypothesize, ["dynamodb:UpdateItem"], [tableArn]);
    allow(f.verify, ["s3:GetObject"], [objects]);
    allow(f.verify, ["s3:ListBucket"], [bucketArn]);
    allow(f.verify, ["dynamodb:PutItem", "dynamodb:UpdateItem"], [tableArn]);
    allow(f.post, ["ssm:GetParameter"], [webhookArn]);
    allow(f.post, ["s3:GetObject"], [objects]);
    allow(f.post, ["s3:ListBucket"], [bucketArn]);
    allow(f.post, ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:Query"], [tableArn]);

    const invoke = (id: string, target: lambda.Function, resultPath?: string) =>
      new tasks.LambdaInvoke(this, id, { lambdaFunction: target, payloadResponseOnly: true, ...(resultPath ? { resultPath } : {}) });
    const dedupe = invoke("Dedupe", f.dedupe, "$.dedupe");
    const gather = invoke("GatherContext", f.gatherContext, "$.context");
    const plan = invoke("Plan", f.plan, "$.plan");
    const runQueries = new sfn.Map(this, "RunQueries", {
      itemsPath: "$.plan.planned",
      maxConcurrency: 3,
      itemSelector: { "incidentId.$": "$.dedupe.incidentId", "query.$": "$$.Map.Item.Value" },
      resultPath: "$.queryRefs",
    });
    runQueries.itemProcessor(invoke("RunQuery", f.runQuery));
    const hypothesize = invoke("Hypothesize", f.hypothesize, "$.hypotheses");
    const verify = invoke("Verify", f.verify, "$.verdict");
    const post = invoke("Post", f.post, "$.post");

    const suppressed = new sfn.Succeed(this, "Suppressed");
    const action = new sfn.Choice(this, "Action?")
      .when(sfn.Condition.stringEquals("$.dedupe.action", "INVESTIGATE"), sfn.Chain.start(gather).next(plan).next(runQueries).next(hypothesize).next(verify).next(post))
      .when(sfn.Condition.stringEquals("$.dedupe.action", "BUDGET_EXHAUSTED"), post)
      .otherwise(suppressed);
    post.next(new sfn.Succeed(this, "Done"));

    this.stateMachine = new sfn.StateMachine(this, "Investigate", {
      stateMachineName: "rca-investigate",
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(sfn.Chain.start(dedupe).next(action)),
      timeout: Duration.minutes(15),
      tracingEnabled: false,
    });

    new events.Rule(this, "AlarmToInvestigation", {
      ruleName: "rca-alarm-to-investigation",
      eventPattern: {
        source: ["aws.cloudwatch"],
        detailType: ["CloudWatch Alarm State Change"],
        detail: { state: { value: ["ALARM"] }, alarmName: props.alarmNames },
      },
      targets: [new targets.SfnStateMachine(this.stateMachine)],
    });
  }
}
