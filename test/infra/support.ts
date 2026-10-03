import type { Template } from "aws-cdk-lib/assertions";

export interface FlatStatement { actions: string[]; resources: unknown[]; effect: string; conditions?: unknown }

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Every statement of every inline IAM policy in a template, with Action and Resource normalised to arrays. */
export function allPolicyStatements(template: Template): FlatStatement[] {
  const out: FlatStatement[] = [];
  for (const res of Object.values(template.findResources("AWS::IAM::Policy"))) {
    for (const s of arr((res as any).Properties.PolicyDocument.Statement) as any[]) {
      out.push({ actions: arr<string>(s.Action), resources: arr(s.Resource), effect: s.Effect, conditions: s.Condition });
    }
  }
  return out;
}
