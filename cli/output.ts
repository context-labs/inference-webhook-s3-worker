import { styleText } from "node:util";

/** A failure the user can act on: what went wrong, and how to fix it. */
export class CliError extends Error {
  readonly fix: string;
  /** 1 for a failure, 2 for a usage error (a bad or missing argument). */
  readonly exitCode: 1 | 2;

  constructor(message: string, fix: string, exitCode: 1 | 2 = 1) {
    super(message);
    this.fix = fix;
    this.exitCode = exitCode;
  }
}

/**
 * Human output for a terminal. In `--json` mode every human line is dropped,
 * so stdout carries only the final JSON result.
 */
export class Output {
  readonly json: boolean;
  private readonly write: (line: string) => void;

  constructor(json: boolean, write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)) {
    this.json = json;
    this.write = write;
  }

  heading(text: string): void {
    this.line(`\n${styleText("bold", text)}`);
  }

  step(text: string): void {
    this.line(`${styleText("cyan", "›")} ${text}`);
  }

  ok(text: string): void {
    this.line(`  ${styleText("green", "✔")} ${text}`);
  }

  warn(text: string, fix: string | null = null): void {
    this.line(`  ${styleText("yellow", "!")} ${text}`);
    if (fix) this.line(`    ${styleText("dim", "Fix:")} ${fix}`);
  }

  fail(text: string, fix: string | null = null): void {
    this.line(`  ${styleText("red", "✖")} ${text}`);
    if (fix) this.line(`    ${styleText("dim", "Fix:")} ${fix}`);
  }

  info(text: string): void {
    this.line(text);
  }

  /** Prints the command result: JSON in `--json` mode, nothing otherwise. */
  result(value: unknown): void {
    if (this.json) this.write(JSON.stringify(value, null, 2));
  }

  error(error: CliError): void {
    if (this.json) {
      this.write(JSON.stringify({ ok: false, error: error.message, fix: error.fix }, null, 2));
      return;
    }
    this.write(`\n${styleText("red", "✖ Error:")} ${error.message}`);
    this.write(`  ${styleText("bold", "Fix:")} ${error.fix}`);
  }

  /** Ends a command with the commands to run next. */
  next(...commands: string[]): void {
    this.line(`\n${styleText("bold", "Next:")} ${commands.join("   ")}`);
  }

  private line(text: string): void {
    if (!this.json) this.write(text);
  }
}

export function code(text: string): string {
  return styleText("cyan", text);
}

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** The package manager that started this process, from the `npm_config_user_agent` every one of them sets. */
export function detectPackageManager(userAgent: string | undefined): PackageManager {
  const name = userAgent?.split("/")[0];
  return name === "pnpm" || name === "yarn" || name === "bun" ? name : "npm";
}

const RUN_CLI: Record<PackageManager, string> = { npm: "npm run cli --", pnpm: "pnpm cli", yarn: "yarn cli", bun: "bun run cli" };
const EXEC: Record<PackageManager, string> = { npm: "npx", pnpm: "pnpm exec", yarn: "yarn", bun: "bunx" };
const packageManager = detectPackageManager(process.env.npm_config_user_agent);

/** A copy-pasteable command line for this CLI, in the form of the package manager that started it. */
export function command(args: string, pm: PackageManager = packageManager): string {
  return `${RUN_CLI[pm]} ${args}`;
}

/** `command`, highlighted. */
export function cli(args: string): string {
  return code(command(args));
}

/** A command line that runs a dependency's binary, such as wrangler, with the package manager that started this CLI. */
export function exec(args: string, pm: PackageManager = packageManager): string {
  return code(`${EXEC[pm]} ${args}`);
}

/** The install command of the package manager that started this CLI. */
export function install(pm: PackageManager = packageManager): string {
  return code(`${pm} install`);
}
