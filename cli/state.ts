import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Cloudflare Worker names: lowercase letters, digits, and dashes, at most 63
// characters, not starting or ending with a dash (they become a DNS label).
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Null when `name` is a valid Worker name, else the reason it is not. */
export function workerNameError(name: string): string | null {
  return WORKER_NAME.test(name)
    ? null
    : `"${name}" is not a valid Worker name. Use 1 to 63 lowercase letters, digits, and dashes, and start and end with a letter or digit.`;
}

export interface S3Settings {
  bucket: string;
  region: string;
  keyPrefix: string;
  endpoint: string | null;
}

/** One deployed Worker, as this CLI created it. Holds no secrets. */
export interface Deployment {
  name: string;
  accountId: string;
  url: string | null;
  statusNamespaceId: string;
  s3: S3Settings;
  /** The webhook's id in the inference.net API (not its identifier), when setup created it through the API. */
  apiWebhookId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The two values the CLI needs to call its own Worker (`status`, `test`).
 * Written to a separate file that only the owner can read. S3 keys are never
 * stored locally.
 */
export interface LocalSecrets {
  pathSecret: string;
  webhookId: string | null;
}

/** Local state in `<dir>/<name>.json`, `<name>.secrets.json`, and `<name>.wrangler.json`. */
export class StateStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  statePath(name: string): string {
    return join(this.dir, `${name}.json`);
  }

  secretsPath(name: string): string {
    return join(this.dir, `${name}.secrets.json`);
  }

  wranglerConfigPath(name: string): string {
    return join(this.dir, `${name}.wrangler.json`);
  }

  async read(name: string): Promise<Deployment | null> {
    return readJson<Deployment>(this.statePath(name));
  }

  async write(deployment: Deployment): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.statePath(deployment.name), `${JSON.stringify(deployment, null, 2)}\n`);
  }

  async readSecrets(name: string): Promise<LocalSecrets | null> {
    return readJson<LocalSecrets>(this.secretsPath(name));
  }

  async writeSecrets(name: string, secrets: LocalSecrets): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.secretsPath(name), `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  }

  /** Writes the Wrangler config for one deployment: name, entry point, and the status KV binding. */
  async writeWranglerConfig(deployment: Deployment, compatibilityDate: string): Promise<string> {
    const path = this.wranglerConfigPath(deployment.name);
    const config = {
      name: deployment.name,
      main: "../src/index.ts",
      compatibility_date: compatibilityDate,
      kv_namespaces: [{ binding: "STATUS", id: deployment.statusNamespaceId }],
    };
    await mkdir(this.dir, { recursive: true });
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
    return path;
  }

  async list(): Promise<Deployment[]> {
    const files = await readdir(this.dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const names = files
      .filter((file) => file.endsWith(".json") && !file.endsWith(".secrets.json") && !file.endsWith(".wrangler.json"))
      .map((file) => file.slice(0, -".json".length))
      .sort();
    const deployments = await Promise.all(names.map((name) => this.read(name)));
    return deployments.filter((deployment) => deployment !== null);
  }

  async remove(name: string): Promise<void> {
    await Promise.all(
      [this.statePath(name), this.secretsPath(name), this.wranglerConfigPath(name)].map((path) => rm(path, { force: true })),
    );
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
