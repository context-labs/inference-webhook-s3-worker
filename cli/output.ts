import { styleText } from "node:util";

/** A failure the user can act on: what went wrong, and how to fix it. */
export class CliError extends Error {
  readonly fix: string | null;

  constructor(message: string, fix: string | null = null) {
    super(message);
    this.fix = fix;
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
    if (error.fix) this.write(`  ${styleText("bold", "Fix:")} ${error.fix}`);
  }

  private line(text: string): void {
    if (!this.json) this.write(text);
  }
}

export function code(text: string): string {
  return styleText("cyan", text);
}

/** A copy-pasteable command line for this CLI. */
export function cli(args: string): string {
  return code(`npm run cli -- ${args}`);
}
