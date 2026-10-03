# ADR 0001: One TypeScript ESM package, with the CDK app in the same repo

Status: accepted, 2026-10-04

## Context

v0.1 needs these pieces, all sharing one set of types:
- a CLI that others can install;
- a pure core;
- Lambda handlers;
- a CDK app.

A monorepo with several packages, as in `serverless-agent`, adds workspace tooling, cross-package build order and duplicated configs. One project this size does not need that.

## Decision

- Use one npm package, `rca-bot`: `"type": "module"`, TypeScript 5.9.3, `module: NodeNext`. Every relative import ends in `.js`.
- `src/` is the shipped library and CLI. The bin is `rca`, built to `dist/`. `infra/` holds the CDK app and is not published.
- The CDK app runs with `tsx` (`cdk.json`: `npx tsx infra/bin/app.ts`). We checked that `aws-cdk-lib@2.272.0` named imports work from ESM under tsx (prototype, 2026-10-04).
- Lambda code is prebundled by `scripts/bundle.mjs` (esbuild 0.28.2) into `dist/lambda/<name>/index.mjs`. Stacks take a `codeFor(name)` prop, so tests inject `Code.fromInline` and never need a bundle.
- npm, not pnpm, so the lockfile (`package-lock.json`) is the one `npm ci` and the published package use.

## What we gave up

- **No reusable CDK construct.** No Construct Hub listing and no jsii. The installable artifact is the CLI.
- **The CDK libraries ship with the package.** `aws-cdk-lib` and `constructs` are devDependencies, so `npm install rca-bot` does not pull them. People who want the stack clone the repo.
