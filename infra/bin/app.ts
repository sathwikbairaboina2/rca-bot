import { App } from "aws-cdk-lib";
import { bundledCode } from "../lib/code.js";
import { ChaosStack } from "../lib/chaos-stack.js";
import { DemoServiceStack } from "../lib/demo-service-stack.js";
import { InvestigatorStack } from "../lib/investigator-stack.js";

const app = new App();

const demo = new DemoServiceStack(app, "RcaDemoService", { codeFor: bundledCode });
const investigator = new InvestigatorStack(app, "RcaInvestigator", {
  codeFor: bundledCode,
  logGroupsByService: { orders: demo.logGroupNames },
  alarmNames: demo.alarmNames,
  // An example Bedrock model id. Check regional availability and override with: cdk synth -c modelId=<id>
  modelId: app.node.tryGetContext("modelId") ?? "anthropic.claude-3-5-haiku-20241022-v1:0",
});
new ChaosStack(app, "RcaChaos", { codeFor: bundledCode, flagParam: demo.flagParam, truthTable: investigator.table });
