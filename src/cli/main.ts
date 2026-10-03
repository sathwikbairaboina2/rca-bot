#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { catalogCommand } from "./commands/catalog.js";
import { chaosCommand } from "./commands/chaos.js";
import { demoCommand } from "./commands/demo.js";
import { incidentCommand } from "./commands/incident.js";
import { realIo, USAGE, type CliIo } from "./io.js";

type Command = (args: string[], io: CliIo) => Promise<number>;

const COMMANDS: Record<string, Command> = {
  demo: demoCommand,
  catalog: catalogCommand,
  incident: incidentCommand,
  chaos: chaosCommand,
};

export function registerCommand(name: string, cmd: Command): void {
  COMMANDS[name] = cmd;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "--help" || name === "-h" || name === "help") {
    io.stdout(USAGE);
    return 0;
  }
  const cmd = COMMANDS[name];
  if (!cmd) {
    io.stderr(`unknown command ${name}`);
    io.stderr(USAGE);
    return 2;
  }
  try {
    return await cmd(rest, io);
  } catch (e) {
    io.stderr(`error: ${(e as Error).message}`);
    return 1;
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  runCli(process.argv.slice(2), realIo).then((code) => process.exit(code));
}
