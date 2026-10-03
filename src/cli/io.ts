export interface CliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  now: () => number;
}

/** One call per line; the real implementation appends the newline. */
export const realIo: CliIo = {
  stdout: (s) => { process.stdout.write(s + "\n"); },
  stderr: (s) => { process.stderr.write(s + "\n"); },
  cwd: process.cwd(),
  env: process.env,
  fetch: (...args) => fetch(...args),
  now: () => Date.now(),
};

export const USAGE = `rca - alarm-to-root-cause bot

Usage:
  rca demo <scenarioId> [--model heuristic] [--seed 1001] [--json]
  rca catalog lint
  rca incident show <incidentId> | --latest [--raw]
  rca eval run --model <spec> [--scenarios all|id,id] [--repeat 3] [--out <file>]
  rca eval fabrication [--repeat 3] [--out <file>]
  rca chaos list
  rca chaos start <scenarioId> [--param /rca-demo/chaos/active] [--region us-east-1] [--endpoint <url>]
  rca chaos stop [--param /rca-demo/chaos/active] [--region us-east-1] [--endpoint <url>]

Models: heuristic | ollama:<name> | bedrock:<modelId> | fabricator`;
