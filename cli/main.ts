#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Command, Option } from "commander";

import * as commands from "./commands.ts";
import { CliError, command, Output } from "./output.ts";
import { terminalPrompter } from "./prompt.ts";
import { StateStore } from "./state.ts";
import { createWrangler } from "./wrangler.ts";

// Colors also turn off for NO_COLOR and when stdout is not a terminal (node:util styleText checks both).
// --json turns them off so no escape codes end up inside JSON strings.
if (process.argv.includes("--no-color") || process.argv.includes("--json")) {
  delete process.env.FORCE_COLOR;
  process.env.NO_COLOR = "1";
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const { compatibility_date: compatibilityDate } = JSON.parse(readFileSync(join(repoRoot, "wrangler.jsonc"), "utf8")) as {
  compatibility_date: string;
};
const { version } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string };

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
      const cliError =
        error instanceof CliError
          ? error
          : new CliError(
              String(error instanceof Error ? error.stack : error),
              "This is unexpected. Open an issue with this output at https://github.com/context-labs/inference-webhook-s3-worker/issues",
            );
      commandDeps.out.error(cliError);
      process.exitCode = cliError.exitCode;
    }
  };
}

/** Help text that ends a command's `--help`: examples in the form of the package manager that started the CLI. */
function examples(...items: Array<[note: string, args: string]>): string {
  return `\nExamples:\n${items.map(([note, args]) => `  # ${note}\n  ${command(args)}`).join("\n\n")}\n`;
}

const program = new Command()
  // Usage lines show the command as the user runs it, for example "npm run cli -- status <name>".
  .name(command("").trimEnd())
  .description("Set up, check, and manage a Cloudflare Worker that saves inference.net webhook results to S3.")
  .version(version)
  .option("--json", "print one JSON result on stdout and never ask questions")
  .option("-y, --yes", "never ask questions; fail when a required value is missing")
  .option("--no-color", "turn off colors (also off with NO_COLOR=1 or when output is not a terminal)")
  .showHelpAfterError()
  // Subcommands copy this, so `status --help` also lists --json, --yes, and --no-color.
  .configureHelp({ showGlobalOptions: true })
  // Usage errors (unknown command or flag, missing argument) exit 2; help with no command exits 0.
  .exitOverride((error) => process.exit(error.exitCode === 0 || error.code === "commander.help" ? 0 : 2))
  .addHelpText(
    "after",
    `${examples(
      ["Set up a new Worker (asks for each value)", "setup"],
      ["Check a Worker", "status my-results"],
      ["Help for one command", "setup --help"],
    )}
Exit codes:
  0    success
  1    a check failed, or the command failed (the message says how to fix it)
  2    usage error: unknown command or flag, or a missing or invalid value
  130  you pressed Ctrl+C at a question
`,
  );

program
  .command("setup")
  .alias("init")
  .summary("check tools, connect a bucket, deploy a new Worker, and register the webhook")
  .description(
    "Check tools, connect a bucket, deploy a new Worker, and register the webhook. Asks for each value it needs and checks it before it moves on. With an inference.net API key (INFERENCE_API_KEY, or typed when asked), it creates the webhook and sends a real test delivery; without one, it walks you through the dashboard.",
  )
  .argument("[name]", "Worker name, unique in your Cloudflare account: lowercase letters, digits, dashes (default: asks; inference-webhook-s3 with --yes)")
  .addOption(new Option("--storage <type>", "where results go (default: asks; aws with --yes, other with --endpoint)").choices(["aws", "r2", "other"]))
  .option("--bucket <bucket>", "bucket name (default: asks)")
  .option("--region <region>", "bucket region (default: the bucket's region on Amazon S3, else asks; auto for R2)")
  .option("--prefix <prefix>", "key prefix, for example embeddings/ (default: asks; none with --yes)")
  .option("--endpoint <url>", "S3-compatible endpoint URL for MinIO and others (default: AWS S3; the account's endpoint for R2)")
  .option("--access-key-id <id>", "S3 access key id (default: AWS_ACCESS_KEY_ID, else asks)")
  .option("--secret-access-key <key>", "S3 secret access key; the env var keeps it out of shell history (default: AWS_SECRET_ACCESS_KEY, else asks)")
  .option(
    "--webhook-id <id>",
    "inference.net webhook identifier, if you already created the webhook (default: creates it with INFERENCE_API_KEY, else asks after deploy)",
  )
  .option("--account-id <id>", "Cloudflare account id (default: CLOUDFLARE_ACCOUNT_ID, else your only account, else asks)")
  .option("--dry-run", "run every check, the S3 write probe included, but create nothing in Cloudflare")
  .addHelpText(
    "after",
    examples(
      ["Answer each question in the terminal", "setup"],
      ["Check everything first, create nothing", "setup my-results --dry-run"],
      [
        "No questions (S3 keys from AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY; creates the webhook with INFERENCE_API_KEY)",
        "setup my-results --yes --bucket my-bucket --region us-east-1 --prefix embeddings/",
      ],
    ),
  )
  .action(run((d, name: string | undefined, options: commands.SetupOptions) => commands.setup(d, name, options)));

program
  .command("status")
  .summary("check the Worker end to end; exits 1 when a check fails")
  .description(
    "Check that the Worker is deployed, reachable, has every setting, can write to S3, and when it last saved or rejected a delivery. Exits 1 when a check fails.",
  )
  .argument("<name>", "Worker name")
  .addHelpText(
    "after",
    examples(["Check every part", "status my-results"], ["Print the result as JSON", "status my-results --json"]),
  )
  .action(run((d, name: string) => commands.status(d, name)));

program
  .command("test")
  .summary("send a test delivery through the Worker and confirm S3 stored it")
  .description(
    "Send a webhook.test delivery to the Worker, the same request inference.net sends, and confirm that S3 stored it. With --remote, inference.net sends it.",
  )
  .argument("<name>", "Worker name")
  .option("--remote", "have inference.net send a real delivery through the webhook API (needs INFERENCE_API_KEY and a webhook setup created)")
  .addHelpText(
    "after",
    examples(
      ["Send a test delivery", "test my-results"],
      ["Have inference.net send one", "test my-results --remote"],
      ["Print the result as JSON", "test my-results --json"],
    ),
  )
  .action(run((d, name: string, options: { remote?: boolean }) => commands.test(d, name, options)));

program
  .command("logs")
  .summary("stream live Worker logs")
  .description("Stream live Worker logs until you press Ctrl+C. With --json, prints raw log events.")
  .argument("<name>", "Worker name")
  .addHelpText("after", examples(["Watch deliveries arrive", "logs my-results"], ["Raw log events, one JSON object each", "logs my-results --json"]))
  .action(run((d, name: string) => commands.logs(d, name)));

program
  .command("config")
  .summary("show settings, or change them and redeploy")
  .description("Show the settings and the webhook URL. With flags, change those settings, redeploy, and check the Worker again.")
  .argument("<name>", "Worker name")
  .option("--bucket <bucket>", "new bucket name (default: unchanged)")
  .option("--region <region>", "new bucket region (default: unchanged)")
  .option("--prefix <prefix>", 'new key prefix, "" for none (default: unchanged)')
  .option("--endpoint <url>", 'new S3-compatible endpoint, "" for AWS S3 (default: unchanged)')
  .option("--webhook-id <id>", "inference.net webhook identifier (default: unchanged)")
  .option("--rotate-s3-keys", "replace the S3 access key; asks for it, or reads the two flags below")
  .option("--access-key-id <id>", "new S3 access key id (default: AWS_ACCESS_KEY_ID, else asks)")
  .option("--secret-access-key <key>", "new S3 secret access key (default: AWS_SECRET_ACCESS_KEY, else asks)")
  .option("--rotate-path-secret", "new secret webhook URL; updates the webhook with INFERENCE_API_KEY, else set it in the dashboard")
  .addHelpText(
    "after",
    examples(
      ["Show the settings and the webhook URL", "config my-results"],
      ["Store the webhook identifier from the dashboard", "config my-results --webhook-id AhALzdz8S"],
      ["Replace the S3 access key", "config my-results --rotate-s3-keys"],
    ),
  )
  .action(run((d, name: string, options: commands.ConfigOptions) => commands.config(d, name, options)));

program
  .command("update")
  .summary("deploy the code in this folder to the Worker")
  .description("Deploy the code in this folder to the Worker, for example after git pull, and check it again.")
  .argument("<name>", "Worker name")
  .addHelpText("after", examples(["Deploy the latest code", "update my-results"]))
  .action(run((d, name: string) => commands.update(d, name)));

program
  .command("list")
  .summary("list the Workers set up from this folder")
  .description("List the Workers set up from this folder, with their URL and bucket.")
  .addHelpText("after", examples(["List Workers", "list"], ["As JSON", "list --json"]))
  .action(run((d) => commands.list(d)));

program
  .command("destroy")
  .summary("delete the Worker and its status store; S3 objects stay")
  .description(
    "Delete the Worker, its status KV namespace, and its local state, after you type its name. Objects in S3 stay. With INFERENCE_API_KEY, it also offers to delete the webhook setup created (--yes deletes it).",
  )
  .argument("<name>", "Worker name")
  .addHelpText("after", examples(["Delete, after you type the name", "destroy my-results"], ["Delete without a question", "destroy my-results --yes"]))
  .action(run((d, name: string, options: { yes?: boolean }) => commands.destroy(d, name, options)));

await program.parseAsync();
