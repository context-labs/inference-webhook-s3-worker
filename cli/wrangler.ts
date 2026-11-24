import { spawn } from "node:child_process";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { CliError, exec, install } from "./output.ts";

export interface WranglerResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface WranglerOptions {
  /** Written to wrangler's stdin. */
  input?: string;
  /** Hand the terminal to wrangler (login, tail). Output is not captured. */
  interactive?: boolean;
  /** Sets CLOUDFLARE_ACCOUNT_ID so wrangler never asks which account to use. */
  accountId?: string;
}

export type Wrangler = (args: string[], options?: WranglerOptions) => Promise<WranglerResult>;

/** Runs the wrangler version installed in this repo. */
export function createWrangler(repoRoot: string): Wrangler {
  const bin = join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js");
  return (args, options = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bin, ...args], {
        cwd: repoRoot,
        stdio: options.interactive ? "inherit" : ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          ...(options.accountId ? { CLOUDFLARE_ACCOUNT_ID: options.accountId } : {}),
          WRANGLER_SEND_METRICS: "false",
          FORCE_COLOR: "0",
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", (error) =>
        reject(new CliError(`Could not run wrangler: ${error.message}`, `Run ${install()} in this folder first.`)),
      );
      child.on("close", (exitCode) => resolve({ code: exitCode ?? 1, stdout, stderr }));
      child.stdin?.end(options.input ?? "");
    });
}

export interface CloudflareAccount {
  id: string;
  name: string;
}

export async function whoami(wrangler: Wrangler): Promise<{ loggedIn: boolean; accounts: CloudflareAccount[] }> {
  const result = await wrangler(["whoami", "--json"]);
  if (result.code !== 0) return { loggedIn: false, accounts: [] };
  const parsed = JSON.parse(result.stdout) as { loggedIn?: boolean; accounts?: CloudflareAccount[] };
  return {
    loggedIn: parsed.loggedIn !== false,
    accounts: (parsed.accounts ?? []).map(({ id, name }) => ({ id, name })),
  };
}

/** True when a Worker with this name exists in the account. */
export async function workerExists(wrangler: Wrangler, name: string, accountId: string): Promise<boolean> {
  const result = await wrangler(["deployments", "status", "--name", name, "--json"], { accountId });
  if (result.code === 0) return true;
  if (/code: 10007/.test(result.stderr + result.stdout)) return false;
  throw wranglerError(`Could not check whether Worker ${name} exists`, result);
}

export async function createStatusNamespace(wrangler: Wrangler, title: string, accountId: string): Promise<string> {
  const result = await wrangler(["kv", "namespace", "create", title], { accountId });
  const id = /"id":\s*"([0-9a-f]{32})"/.exec(result.stdout)?.[1];
  if (result.code !== 0 || !id) throw wranglerError(`Could not create KV namespace ${title}`, result);
  return id;
}

/** Creates an R2 bucket or a queue. One that already exists counts, so `update --buffered` can run again. */
export async function createResource(wrangler: Wrangler, kind: "r2 bucket" | "queues", name: string, accountId: string): Promise<void> {
  const result = await wrangler([...kind.split(" "), "create", name], { accountId });
  if (result.code !== 0 && !/code: (10004|11009)/.test(result.stderr + result.stdout)) {
    throw wranglerError(`Could not create ${kind === "queues" ? "queue" : "R2 bucket"} ${name}`, result);
  }
}

/** Deletes an R2 bucket or a queue. R2 refuses to delete a bucket that still holds objects: then this returns "not empty". */
export async function deleteResource(
  wrangler: Wrangler,
  kind: "r2 bucket" | "queues",
  name: string,
  accountId: string,
): Promise<"deleted" | "missing" | "not empty"> {
  const result = await wrangler([...kind.split(" "), "delete", name], { accountId, input: "y\n" });
  const output = result.stderr + result.stdout;
  if (result.code === 0) return "deleted";
  if (/code: 10006|does not exist/i.test(output)) return "missing";
  if (/not empty|code: 10008/i.test(output)) return "not empty";
  throw wranglerError(`Could not delete ${kind === "queues" ? "queue" : "R2 bucket"} ${name}`, result);
}

/** Deploys the Worker described by a Wrangler config file and returns its workers.dev URL. */
export async function deployWorker(wrangler: Wrangler, configPath: string, accountId: string): Promise<string> {
  const result = await wrangler(["deploy", "--config", configPath], { accountId });
  if (result.code !== 0) {
    if (/workers\.dev subdomain/i.test(result.stderr)) {
      throw wranglerError(
        "wrangler deploy failed",
        result,
        "Open Workers & Pages in the Cloudflare dashboard once to create your workers.dev subdomain, then run this command again.",
      );
    }
    throw wranglerError("wrangler deploy failed", result);
  }
  const url = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(result.stdout)?.[0];
  if (!url) {
    throw new CliError(
      "The Worker deployed, but wrangler printed no workers.dev URL.",
      "Turn on the workers.dev route for this Worker in the Cloudflare dashboard (Settings → Domains & Routes).",
    );
  }
  return url;
}

/** Sets (string) or deletes (null) Worker secrets in one new deployment. Values go over stdin, never to disk. */
export async function putSecrets(
  wrangler: Wrangler,
  name: string,
  secrets: Record<string, string | null>,
  accountId: string,
): Promise<void> {
  const result = await wrangler(["secret", "bulk", "--name", name], { input: JSON.stringify(secrets), accountId });
  if (result.code !== 0) throw wranglerError(`Could not store secrets on Worker ${name}`, result);
}

export async function deleteWorker(wrangler: Wrangler, name: string, accountId: string): Promise<"deleted" | "missing"> {
  const result = await wrangler(["delete", name], { accountId });
  if (result.code === 0) return "deleted";
  if (/code: 10007|does not exist/i.test(result.stderr + result.stdout)) return "missing";
  throw wranglerError(`Could not delete Worker ${name}`, result);
}

export async function deleteNamespace(wrangler: Wrangler, namespaceId: string, accountId: string): Promise<void> {
  const result = await wrangler(["kv", "namespace", "delete", "--namespace-id", namespaceId, "--skip-confirmation"], {
    accountId,
  });
  if (result.code !== 0 && !/code: 10013|not found/i.test(result.stderr + result.stdout)) {
    throw wranglerError(`Could not delete KV namespace ${namespaceId}`, result);
  }
}

function wranglerError(
  message: string,
  result: WranglerResult,
  fix = `Check your Cloudflare login with ${exec("wrangler whoami")}, then run the command again.`,
): CliError {
  // Wrangler colors its errors even with FORCE_COLOR=0.
  const detail = stripVTControlCharacters(result.stderr || result.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("🪵") && !line.startsWith("⛅️") && !/^─+$/.test(line))
    .slice(-4)
    .join(" | ");
  return new CliError(`${message}: ${detail || `wrangler exited with code ${result.code}`}`, fix);
}
