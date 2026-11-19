#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Command, Option } from "commander";

import * as commands from "./commands.ts";
import { CliError, Output } from "./output.ts";
import { terminalPrompter } from "./prompt.ts";
import { StateStore } from "./state.ts";
import { createWrangler } from "./wrangler.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const { compatibility_date: compatibilityDate } = JSON.parse(readFileSync(join(repoRoot, "wrangler.jsonc"), "utf8")) as {
  compatibility_date: string;
};

interface GlobalOptions {
  json?: boolean;
  yes?: boolean;
}

function deps(command: Command): commands.Deps {
  const { json = false, yes = false } = command.optsWithGlobals<GlobalOptions>();
  const interactive = !json && !yes && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return {
    wrangler: createWrangler(repoRoot),
    store: new StateStore(join(repoRoot, ".webhook-s3")),
    out: new Output(json),
    prompt: interactive ? terminalPrompter : null,
    fetch,
    env: process.env,
    nodeVersion: process.versions.node,
    compatibilityDate,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
  };
}

/** Runs one command, and turns failures into a message with a fix and a non-zero exit code. */
function run<A extends unknown[]>(action: (deps: commands.Deps, ...args: A) => Promise<unknown>) {
  return async (...args: unknown[]): Promise<void> => {
    const command = args[args.length - 1] as Command;
    const commandDeps = deps(command);
    try {
      // Commander passes (...arguments, options, command); hand actions the options merged with --json/--yes.
      const result = await action(commandDeps, ...([...args.slice(0, -2), command.optsWithGlobals()] as A));
      if (result && typeof result === "object" && "ok" in result && result.ok === false) process.exitCode = 1;
    } catch (error) {
      if (error instanceof Error && error.name === "ExitPromptError") {
        process.exitCode = 130;
        return;
      }
      commandDeps.out.error(error instanceof CliError ? error : new CliError(String(error instanceof Error ? error.stack : error)));
      process.exitCode = 1;
    }
  };
}

const program = new Command()
  .name("webhook-s3")
  .description("Set up, check, and manage a Cloudflare Worker that saves inference.net webhook results to S3.")
  .option("--json", "print one JSON result on stdout and never ask questions")
  .option("-y, --yes", "never ask questions; fail when a required value is missing")
  .showHelpAfterError();

program
  .command("setup")
  .alias("init")
  .description("check tools, connect a bucket, deploy a new Worker, and register the webhook")
  .argument("[name]", "Worker name, unique in your Cloudflare account (lowercase letters, digits, dashes)")
  .addOption(new Option("--storage <type>", "where results go").choices(["aws", "r2", "other"]))
  .option("--bucket <bucket>", "bucket name")
  .option("--region <region>", "bucket region (default us-east-1; auto for R2)")
  .option("--prefix <prefix>", "key prefix, for example embeddings/")
  .option("--endpoint <url>", "S3-compatible endpoint URL (R2, MinIO, ...)")
  .option("--access-key-id <id>", "S3 access key id (or AWS_ACCESS_KEY_ID)")
  .option("--secret-access-key <key>", "S3 secret access key (or AWS_SECRET_ACCESS_KEY; safer than a flag)")
  .option("--webhook-id <id>", "inference.net webhook identifier, if you already created the webhook")
  .option("--account-id <id>", "Cloudflare account id (or CLOUDFLARE_ACCOUNT_ID)")
  .option("--dry-run", "run every check (S3 write probe included) but create nothing in Cloudflare")
  .action(run((d, name: string | undefined, options: commands.SetupOptions) => commands.setup(d, name, options)));

program
  .command("status")
  .description("check that the Worker is deployed, reachable, configured, can write to S3, and receives deliveries")
  .argument("<name>", "Worker name")
  .action(run((d, name: string) => commands.status(d, name)));

program
  .command("test")
  .description("send a test delivery through the Worker and confirm S3 stored it")
  .argument("<name>", "Worker name")
  .action(run((d, name: string) => commands.test(d, name)));

program
  .command("logs")
  .description("stream live Worker logs (--json prints raw log events)")
  .argument("<name>", "Worker name")
  .action(run((d, name: string) => commands.logs(d, name)));

program
  .command("config")
  .description("show settings, or change them and redeploy")
  .argument("<name>", "Worker name")
  .option("--bucket <bucket>", "new bucket name")
  .option("--region <region>", "new bucket region")
  .option("--prefix <prefix>", 'new key prefix ("" for none)')
  .option("--endpoint <url>", 'new S3-compatible endpoint ("" for AWS S3)')
  .option("--webhook-id <id>", "inference.net webhook identifier")
  .option("--rotate-s3-keys", "replace the S3 access key (asks for it, or reads the flags below)")
  .option("--access-key-id <id>", "new S3 access key id")
  .option("--secret-access-key <key>", "new S3 secret access key")
  .option("--rotate-path-secret", "new secret webhook URL; update it in the inference.net dashboard afterwards")
  .action(run((d, name: string, options: commands.ConfigOptions) => commands.config(d, name, options)));

program
  .command("update")
  .description("deploy the code in this folder to the Worker, for example after git pull")
  .argument("<name>", "Worker name")
  .action(run((d, name: string) => commands.update(d, name)));

program
  .command("list")
  .description("list the Workers set up from this folder")
  .action(run((d) => commands.list(d)));

program
  .command("destroy")
  .description("delete the Worker and its status store (asks first; S3 objects are kept)")
  .argument("<name>", "Worker name")
  .action(run((d, name: string, options: { yes?: boolean }) => commands.destroy(d, name, options)));

await program.parseAsync();
