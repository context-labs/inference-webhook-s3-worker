import { randomBytes } from "node:crypto";

import { SAFE_KEY_PREFIX, type WorkerStatus } from "../src/index.ts";
import { CliError, cli, code, type Output } from "./output.ts";
import type { Prompter } from "./prompt.ts";
import { probeS3Write, type S3Keys } from "./s3.ts";
import { type Deployment, type LocalSecrets, type S3Settings, type StateStore, workerNameError } from "./state.ts";
import {
  createStatusNamespace,
  deleteNamespace,
  deleteWorker,
  deployWorker,
  putSecrets,
  whoami,
  type Wrangler,
  workerExists,
} from "./wrangler.ts";

export interface Deps {
  wrangler: Wrangler;
  store: StateStore;
  out: Output;
  /** Null when the command must not ask questions (`--json`, `--yes`, or no terminal). */
  prompt: Prompter | null;
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  nodeVersion: string;
  compatibilityDate: string;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

const MIN_NODE = [22, 18] as const;
const DEFAULT_NAME = "inference-webhook-s3";
const WORKER_READY_TIMEOUT_MS = 90_000;
const TEST_DELIVERY_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 3_000;

export type Storage = "aws" | "r2" | "other";

export interface SetupOptions {
  storage?: Storage;
  bucket?: string;
  region?: string;
  prefix?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  webhookId?: string;
  accountId?: string;
  /** Run every check, the S3 write probe included, but change nothing in Cloudflare. */
  dryRun?: boolean;
}

/** `setup`: checks tools, asks for settings, proves S3 access, deploys, and walks through webhook registration. */
export async function setup(deps: Deps, nameArgument: string | undefined, options: SetupOptions) {
  const { out, prompt } = deps;
  const startedAt = deps.now();
  const earlyNameError = nameArgument === undefined ? null : workerNameError(nameArgument);
  if (earlyNameError) throw new CliError(earlyNameError, `Example: ${cli(`setup ${DEFAULT_NAME}`)}`);
  out.heading("1/5  Check tools");
  const accountId = await checkTools(deps, options.accountId);

  out.heading("2/5  Name the Worker");
  const name = nameArgument ?? (await ask(deps, "Worker name (unique in your Cloudflare account)", { default: DEFAULT_NAME }, "the name argument"));
  const nameError = workerNameError(name);
  if (nameError) throw new CliError(nameError, `Example: ${cli(`setup ${DEFAULT_NAME}`)}`);
  if (await deps.store.read(name)) {
    throw new CliError(
      `${name} is already set up from this folder.`,
      `Run ${cli(`status ${name}`)}, ${cli(`update ${name}`)}, or ${cli(`config ${name}`)}. To start over, run ${cli(`destroy ${name}`)}.`,
    );
  }
  out.step(`Checking that no Worker named ${name} exists in the account`);
  if (await workerExists(deps.wrangler, name, accountId)) {
    throw new CliError(
      `A Worker named ${name} already exists in this Cloudflare account.`,
      "Pick another name. Worker names are unique per account, and setup never overwrites a Worker it did not create.",
    );
  }
  out.ok(`${name} is free`);

  out.heading("3/5  Connect the bucket");
  const s3 = await askS3Settings(deps, options, accountId);
  const keys = await askS3Keys(deps, options);
  out.step(`Writing a test object to ${s3.bucket}/${s3.keyPrefix}`);
  const probe = await probeS3Write(s3, keys);
  out.ok(`The key can write to ${s3.bucket}/${s3.keyPrefix}`);
  if (!probe.deleted) out.info(`    Left ${probe.key} in the bucket (the key has no s3:DeleteObject; that is fine).`);

  if (options.dryRun) {
    const secretNames = Object.keys(workerSecrets(s3, keys, { pathSecret: "x", webhookId: options.webhookId ?? null }));
    out.heading("Dry run: every check passed. Nothing was created in Cloudflare.");
    out.info(`  Setup would now:`);
    out.info(`    1. Create KV namespace ${name}-status in account ${accountId}`);
    out.info(`    2. Deploy Worker ${name} to https://${name}.<your-subdomain>.workers.dev`);
    out.info(`    3. Store ${secretNames.length} encrypted Worker secrets: ${secretNames.join(", ")}`);
    out.info(`    4. Check the deployed Worker, then walk you through registering the webhook URL on inference.net`);
    out.info(`\n  Run it for real: ${cli(`setup ${name}`)}`);
    const result = { ok: true, dryRun: true, name, accountId, s3, secrets: secretNames };
    out.result(result);
    return result;
  }

  out.heading("4/5  Deploy");
  out.step("Creating a KV namespace for delivery status");
  const statusNamespaceId = await createStatusNamespace(deps.wrangler, `${name}-status`, accountId);
  out.ok(`KV namespace ${statusNamespaceId}`);
  const timestamp = deps.now().toISOString();
  let deployment: Deployment = {
    name,
    accountId,
    url: null,
    statusNamespaceId,
    s3,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const secrets: LocalSecrets = { pathSecret: randomBytes(32).toString("hex"), webhookId: options.webhookId ?? null };
  await deps.store.write(deployment);
  await deps.store.writeSecrets(name, secrets);

  deployment = await deploy(deps, deployment);
  out.step("Storing settings as encrypted Worker secrets");
  await putSecrets(deps.wrangler, name, workerSecrets(s3, keys, secrets), accountId);
  out.ok("Secrets stored. Your S3 keys live only in your Cloudflare account.");
  out.step("Waiting for the Worker to answer (a new workers.dev URL can take a minute)");
  const status = await waitForWorker(deps, deployment, secrets);
  checkProbe(out, status);

  out.heading("5/5  Register the webhook on inference.net");
  const webhookUrl = `${deployment.url}/${secrets.pathSecret}`;
  if (!secrets.webhookId) {
    out.info("  1. In the inference.net dashboard, open Settings → Integrations → Create Webhook.");
    out.info(`  2. Paste this URL:\n\n     ${code(webhookUrl)}\n`);
    out.info("  3. Save it, and copy the webhook identifier it shows.");
    const webhookId = prompt ? (await prompt.input("Webhook identifier (leave empty to add it later)")).trim() : "";
    if (webhookId) {
      await setWebhookId(deps, deployment, secrets, webhookId);
    } else {
      out.warn(
        "The Worker rejects deliveries until it knows the webhook identifier.",
        `Run ${cli(`config ${name} --webhook-id <identifier>`)} after you create the webhook.`,
      );
    }
  } else {
    out.ok(`Webhook identifier ${secrets.webhookId} stored. Register this URL on it: ${code(webhookUrl)}`);
  }

  let testDelivery = false;
  if (secrets.webhookId && prompt && (await prompt.confirm("Wait here while you click Test on the webhook in the dashboard?", true))) {
    testDelivery = await waitForTestDelivery(deps, deployment, secrets, startedAt);
  }

  out.heading(`Done. ${name} is live.`);
  out.info(`  Webhook URL:   ${code(webhookUrl)}`);
  out.info(`  Objects go to: ${s3.bucket}/${s3.keyPrefix}{groups,generations}/<id>.json`);
  out.info(`  Next:          ${cli(`status ${name}`)}   ${cli(`test ${name}`)}   ${cli(`logs ${name}`)}`);
  const result = { ok: true, name, accountId, url: deployment.url, webhookUrl, webhookIdSet: Boolean(secrets.webhookId), testDelivery, s3 };
  out.result(result);
  return result;
}

interface Check {
  check: string;
  ok: boolean;
  detail: string;
  fix: string | null;
}

/** `status`: Worker deployed and reachable, settings complete, S3 writable, and recent deliveries. */
export async function status(deps: Deps, name: string) {
  const { out } = deps;
  const { deployment, secrets } = await load(deps, name);
  const checks: Check[] = [];
  const add = (check: Check, warnOnly = false): void => {
    checks.push(check);
    if (check.ok) out.ok(check.detail);
    else if (warnOnly) out.warn(check.detail, check.fix);
    else out.fail(check.detail, check.fix);
  };

  out.heading(`Status of ${name}`);
  const deployed = await workerExists(deps.wrangler, name, deployment.accountId);
  add({
    check: "deployed",
    ok: deployed,
    detail: deployed ? `Deployed in account ${deployment.accountId}` : "The Worker is not deployed in the Cloudflare account",
    fix: deployed ? null : `Run ${cli(`update ${name}`)} to deploy it again.`,
  });

  const workerStatus = deployed ? await fetchStatus(deps, deployment, secrets, true) : null;
  if (deployed) {
    add({
      check: "reachable",
      ok: workerStatus !== null,
      detail: workerStatus ? `Reachable at ${deployment.url}` : `No answer from ${deployment.url}/<path secret>/status`,
      fix: workerStatus ? null : `Run ${cli(`update ${name}`)}. If it persists, run ${cli(`logs ${name}`)} while you retry.`,
    });
  }

  if (workerStatus) {
    const missing = workerStatus.missingSettings;
    const onlyWebhookId = missing.length === 1 && missing[0] === "INFERENCE_WEBHOOK_ID";
    add({
      check: "settings",
      ok: missing.length === 0,
      detail: missing.length === 0 ? "All settings present" : `Missing settings: ${missing.join(", ")}`,
      fix: onlyWebhookId
        ? `Create the webhook on inference.net, then run ${cli(`config ${name} --webhook-id <identifier>`)}.`
        : `Run ${cli(`config ${name}`)} to set them.`,
    });
    const probe = workerStatus.probe;
    add({
      check: "s3",
      ok: probe?.ok ?? false,
      detail: probe?.ok ? `S3 write works (${probe.key})` : `S3 write failed: ${probe?.message ?? "S3 settings missing"}`,
      fix: probe?.ok ? null : `Check the bucket and keys, then run ${cli(`config ${name} --rotate-s3-keys`)} if the keys changed.`,
    });
    const last = workerStatus.lastDelivery;
    add(
      {
        check: "deliveries",
        ok: last !== null,
        detail: last ? `Last delivery ${ago(deps, last.at)}: ${last.event} → ${last.key}` : "No deliveries recorded yet",
        fix: last ? null : `Click Test on the webhook in the inference.net dashboard, or run ${cli(`test ${name}`)}.`,
      },
      true,
    );
    const error = workerStatus.lastError;
    if (error && (!last || error.at > last.at)) {
      add(
        {
          check: "last-error",
          ok: false,
          detail: `Last error ${ago(deps, error.at)}: HTTP ${error.status} ${error.message}`,
          fix: errorFix(name, error.status),
        },
        true,
      );
    }
  }

  const ok = checks.every((check) => check.ok || check.check === "deliveries" || check.check === "last-error");
  out.info(ok ? `\n${name} is healthy.` : `\n${name} needs attention.`);
  const result = { ok, name, url: deployment.url, checks, worker: workerStatus };
  out.result(result);
  return result;
}

/** `test`: sends a signed-off synthetic delivery through the real Worker and S3. */
export async function test(deps: Deps, name: string) {
  const { out } = deps;
  const { deployment, secrets } = await load(deps, name);
  if (!secrets.webhookId) {
    throw new CliError(`${name} has no webhook identifier yet.`, `Run ${cli(`config ${name} --webhook-id <identifier>`)}.`);
  }
  out.heading(`Test ${name}`);
  out.step("Sending a webhook.test delivery, the same request inference.net sends");
  const response = await deps
    .fetch(`${deployment.url}/${secrets.pathSecret}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Kuzco-Webhook/1.0",
        "X-Inference-Event": "webhook.test",
        "X-Inference-Webhook-ID": secrets.webhookId,
        "X-Inference-Delivery-Attempt": "1",
      },
      body: JSON.stringify({
        event: "webhook.test",
        timestamp: deps.now().toISOString(),
        webhook_id: secrets.webhookId,
        data: { message: "Test event from the inference-webhook-s3-worker CLI" },
      }),
    })
    .catch((error: unknown) => {
      throw new CliError(`Could not reach ${deployment.url}: ${String(error)}`, `Run ${cli(`status ${name}`)}.`);
    });
  const body = await response.text();
  if (response.status !== 200) {
    throw new CliError(`The Worker answered HTTP ${response.status}: ${body}`, errorFix(name, response.status));
  }
  out.ok(`S3 accepted ${deployment.s3.bucket}/${body} (the Worker answers 200 only after S3 confirms the write)`);
  const result = { ok: true, name, bucket: deployment.s3.bucket, key: body };
  out.result(result);
  return result;
}

/** `logs`: streams live Worker logs from Cloudflare. */
export async function logs(deps: Deps, name: string) {
  const { deployment } = await load(deps, name);
  deps.out.step(`Streaming logs for ${name}. Press Ctrl+C to stop.`);
  const result = await deps.wrangler(["tail", name, "--format", deps.out.json ? "json" : "pretty"], {
    interactive: true,
    accountId: deployment.accountId,
  });
  if (result.code !== 0) throw new CliError(`wrangler tail exited with code ${result.code}`, `Run ${cli(`status ${name}`)}.`);
}

export interface ConfigOptions {
  bucket?: string;
  region?: string;
  prefix?: string;
  endpoint?: string;
  webhookId?: string;
  rotateS3Keys?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  rotatePathSecret?: boolean;
}

/** `config`: shows settings, or changes them and redeploys (wrangler deploys a new version on every secret change). */
export async function config(deps: Deps, name: string, options: ConfigOptions) {
  const { out } = deps;
  let { deployment, secrets } = await load(deps, name);
  const changes: Record<string, string | null> = {};
  const s3: S3Settings = { ...deployment.s3 };

  if (options.bucket !== undefined) changes.S3_BUCKET = s3.bucket = options.bucket;
  if (options.region !== undefined) changes.S3_REGION = s3.region = options.region;
  if (options.prefix !== undefined) {
    s3.keyPrefix = normalizePrefix(out, options.prefix);
    changes.S3_KEY_PREFIX = s3.keyPrefix || null;
  }
  if (options.endpoint !== undefined) {
    s3.endpoint = options.endpoint || null;
    changes.S3_ENDPOINT = s3.endpoint;
  }
  if (options.rotateS3Keys || options.accessKeyId || options.secretAccessKey) {
    const keys = await askS3Keys(deps, options);
    out.step(`Checking that the new key can write to ${s3.bucket}/${s3.keyPrefix}`);
    await probeS3Write(s3, keys);
    out.ok("The new key works");
    changes.S3_ACCESS_KEY_ID = keys.accessKeyId;
    changes.S3_SECRET_ACCESS_KEY = keys.secretAccessKey;
  }
  if (options.webhookId !== undefined) {
    secrets = { ...secrets, webhookId: options.webhookId };
    changes.INFERENCE_WEBHOOK_ID = options.webhookId;
  }
  if (options.rotatePathSecret) {
    secrets = { ...secrets, pathSecret: randomBytes(32).toString("hex") };
    changes.WEBHOOK_PATH_SECRET = secrets.pathSecret;
  }

  const webhookUrl = (): string => `${deployment.url}/${secrets.pathSecret}`;
  if (Object.keys(changes).length === 0) {
    out.heading(`Settings of ${name}`);
    out.info(`  Account:       ${deployment.accountId}`);
    out.info(`  Webhook URL:   ${code(webhookUrl())}`);
    out.info(`  Webhook id:    ${secrets.webhookId ?? "(not set)"}`);
    out.info(`  Bucket:        ${deployment.s3.bucket} (${deployment.s3.region})`);
    out.info(`  Key prefix:    ${deployment.s3.keyPrefix || "(none)"}`);
    out.info(`  Endpoint:      ${deployment.s3.endpoint ?? "AWS S3"}`);
    out.info(`  State files:   ${deps.store.statePath(name)}, ${deps.store.secretsPath(name)}`);
    out.info(`\n  Change settings with flags, for example ${cli(`config ${name} --prefix embeddings/`)}. See ${cli("config --help")}.`);
    const result = { ok: true, ...deployment, webhookUrl: webhookUrl(), webhookId: secrets.webhookId };
    out.result(result);
    return result;
  }

  out.heading(`Update ${name}`);
  out.step(`Updating ${Object.keys(changes).join(", ")}`);
  await putSecrets(deps.wrangler, name, changes, deployment.accountId);
  deployment = { ...deployment, s3, updatedAt: deps.now().toISOString() };
  await deps.store.write(deployment);
  await deps.store.writeSecrets(name, secrets);
  out.ok("Wrangler deployed a new version with the new settings");
  if (options.rotatePathSecret) {
    out.warn(
      `The webhook URL changed. Deliveries to the old URL now get 404 (inference.net retries them for about 3 days).`,
      `In the inference.net dashboard, set the webhook URL to ${code(webhookUrl())}`,
    );
  }
  out.step("Checking the Worker with the new settings");
  const workerStatus = await waitForWorker(deps, deployment, secrets);
  checkProbe(out, workerStatus);
  const result = { ok: true, name, changed: Object.keys(changes), webhookUrl: webhookUrl() };
  out.result(result);
  return result;
}

/** `update`: deploys the code in this folder (for example after `git pull`) to an existing Worker. */
export async function update(deps: Deps, name: string) {
  const { deployment, secrets } = await load(deps, name);
  deps.out.heading(`Update ${name}`);
  const updated = await deploy(deps, deployment);
  deps.out.step("Checking the Worker");
  checkProbe(deps.out, await waitForWorker(deps, updated, secrets));
  const result = { ok: true, name, url: updated.url };
  deps.out.result(result);
  return result;
}

/** `list`: the Workers set up from this folder. */
export async function list(deps: Deps) {
  const deployments = await deps.store.list();
  if (deployments.length === 0) {
    deps.out.info(`No Workers set up from this folder yet. Run ${cli("setup")}.`);
  }
  for (const deployment of deployments) {
    deps.out.info(
      `${code(deployment.name.padEnd(28))} ${(deployment.url ?? "(not deployed)").padEnd(56)} ${deployment.s3.bucket}/${deployment.s3.keyPrefix}`,
    );
  }
  const result = deployments.map(({ name, url, accountId, s3, updatedAt }) => ({ name, url, accountId, s3, updatedAt }));
  deps.out.result(result);
  return result;
}

/** `destroy`: deletes the Worker, its KV namespace, and the local state. Objects in S3 stay. */
export async function destroy(deps: Deps, name: string, options: { yes?: boolean }) {
  const { out, prompt } = deps;
  const { deployment } = await load(deps, name);
  if (!options.yes) {
    if (!prompt) throw new CliError(`destroy needs confirmation.`, `Run it in a terminal, or add ${code("--yes")}.`);
    const typed = await prompt.input(`This deletes Worker ${name}. Deliveries to it will fail. Type the name to confirm`);
    if (typed.trim() !== name) throw new CliError("The name did not match. Nothing was deleted.");
  }
  out.heading(`Destroy ${name}`);
  out.step("Deleting the Worker");
  const worker = await deleteWorker(deps.wrangler, name, deployment.accountId);
  out.ok(worker === "deleted" ? "Worker deleted" : "Worker was already gone");
  out.step("Deleting the status KV namespace");
  await deleteNamespace(deps.wrangler, deployment.statusNamespaceId, deployment.accountId);
  out.ok("KV namespace deleted");
  await deps.store.remove(name);
  out.ok("Local state removed");
  out.info(`\nObjects in ${deployment.s3.bucket} were not touched. Delete the webhook in the inference.net dashboard too.`);
  const result = { ok: true, name, worker };
  out.result(result);
  return result;
}

async function checkTools(deps: Deps, accountOption: string | undefined): Promise<string> {
  const { out, prompt } = deps;
  const [major = 0, minor = 0] = deps.nodeVersion.split(".").map(Number);
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    throw new CliError(`Node.js ${deps.nodeVersion} is too old.`, `Install Node.js ${MIN_NODE.join(".")} or later (https://nodejs.org).`);
  }
  out.ok(`Node.js ${deps.nodeVersion}`);

  const version = await deps.wrangler(["--version"]);
  if (version.code !== 0) throw new CliError("wrangler does not run.", `Run ${code("npm install")} in this folder.`);
  out.ok(`wrangler ${version.stdout.trim().split(/\s+/).pop()}`);

  let account = await whoami(deps.wrangler);
  if (!account.loggedIn) {
    if (!prompt || !(await prompt.confirm("You are not logged in to Cloudflare. Log in now?", true))) {
      throw new CliError("Not logged in to Cloudflare.", `Run ${code("npx wrangler login")}, or set CLOUDFLARE_API_TOKEN.`);
    }
    await deps.wrangler(["login"], { interactive: true });
    account = await whoami(deps.wrangler);
    if (!account.loggedIn) throw new CliError("Cloudflare login did not finish.", `Run ${code("npx wrangler login")}.`);
  }

  const wanted = accountOption ?? deps.env.CLOUDFLARE_ACCOUNT_ID;
  const accounts = account.accounts;
  let chosenId = wanted ?? (accounts.length === 1 ? accounts[0]?.id : undefined);
  if (!chosenId && prompt && accounts.length > 1) {
    chosenId = await prompt.select(
      "Cloudflare account",
      accounts.map(({ id, name }) => ({ name: `${name} (${id})`, value: id })),
    );
  }
  const chosen = accounts.find((candidate) => candidate.id === chosenId);
  if (!chosen) {
    throw new CliError(
      wanted ? `Cloudflare account ${wanted} is not available to this login.` : "Pick a Cloudflare account.",
      `Pass ${code("--account-id <id>")}. Your accounts: ${accounts.map(({ id, name }) => `${name} (${id})`).join(", ") || "none"}.`,
    );
  }
  out.ok(`Logged in to Cloudflare account ${chosen.name} (${chosen.id})`);
  return chosen.id;
}

async function askS3Settings(deps: Deps, options: SetupOptions, accountId: string): Promise<S3Settings> {
  const { prompt } = deps;
  const storage: Storage =
    options.storage ??
    (options.endpoint
      ? "other"
      : prompt && !options.bucket
        ? await prompt.select<Storage>("Where should results go?", [
            { name: "Amazon S3", value: "aws" },
            { name: "Cloudflare R2", value: "r2" },
            { name: "Other S3-compatible storage (MinIO, Backblaze B2, ...)", value: "other" },
          ])
        : "aws");
  const bucket = options.bucket ?? (await ask(deps, "Bucket name", {}, "--bucket"));
  const region =
    options.region ?? (storage === "r2" ? "auto" : await ask(deps, "Bucket region", { default: "us-east-1" }, "--region"));
  const endpoint =
    options.endpoint ??
    (storage === "r2"
      ? `https://${accountId}.r2.cloudflarestorage.com`
      : storage === "other"
        ? await ask(deps, "S3 endpoint URL", { validate: (value) => /^https?:\/\//.test(value) || "Start with https://" }, "--endpoint")
        : null);
  const rawPrefix =
    options.prefix ??
    (prompt
      ? await prompt.input("Key prefix (optional, for example embeddings/)", {
          default: "",
          validate: (value) => SAFE_KEY_PREFIX.test(value) || "Use only A-Z a-z 0-9 / _ . -",
        })
      : "");
  return { bucket, region, keyPrefix: normalizePrefix(deps.out, rawPrefix), endpoint };
}

async function askS3Keys(deps: Deps, options: { accessKeyId?: string; secretAccessKey?: string }): Promise<S3Keys> {
  const accessKeyId =
    options.accessKeyId ?? deps.env.AWS_ACCESS_KEY_ID ?? (await ask(deps, "Access key id", {}, "--access-key-id or AWS_ACCESS_KEY_ID"));
  const secretAccessKey =
    options.secretAccessKey ??
    deps.env.AWS_SECRET_ACCESS_KEY ??
    (deps.prompt
      ? await deps.prompt.password("Secret access key")
      : missing("--secret-access-key or AWS_SECRET_ACCESS_KEY"));
  return { accessKeyId, secretAccessKey };
}

function normalizePrefix(out: Output, prefix: string): string {
  if (!SAFE_KEY_PREFIX.test(prefix)) {
    throw new CliError(`Key prefix "${prefix}" has a character that is not allowed.`, "Use only A-Z a-z 0-9 / _ . -");
  }
  if (prefix && !prefix.endsWith("/")) {
    out.info(`    Using key prefix "${prefix}/" so keys look like ${prefix}/groups/<id>.json.`);
    return `${prefix}/`;
  }
  return prefix;
}

async function ask(
  deps: Deps,
  message: string,
  options: { default?: string; validate?: (value: string) => string | true },
  flag: string,
): Promise<string> {
  if (!deps.prompt) return options.default ?? missing(flag);
  return (await deps.prompt.input(message, { validate: (value) => value.trim().length > 0 || "Required", ...options })).trim();
}

function missing(flag: string): never {
  throw new CliError(
    `Missing ${flag}. The CLI cannot ask for it with --json, with --yes, or without a terminal.`,
    `Pass ${code(flag)}, or run the command in a terminal without --json and --yes.`,
  );
}

async function load(deps: Deps, name: string): Promise<{ deployment: Deployment; secrets: LocalSecrets }> {
  const deployment = await deps.store.read(name);
  const secrets = await deps.store.readSecrets(name);
  if (!deployment || !secrets) {
    throw new CliError(
      `No Worker named ${name} is set up from this folder.`,
      `Run ${cli("list")} to see Workers set up here, or ${cli(`setup ${name}`)} to create it.`,
    );
  }
  return { deployment, secrets };
}

async function deploy(deps: Deps, deployment: Deployment): Promise<Deployment> {
  deps.out.step(`Deploying ${deployment.name}`);
  const configPath = await deps.store.writeWranglerConfig(deployment, deps.compatibilityDate);
  const url = await deployWorker(deps.wrangler, configPath, deployment.accountId);
  const deployed = { ...deployment, url, updatedAt: deps.now().toISOString() };
  await deps.store.write(deployed);
  deps.out.ok(`Deployed to ${url}`);
  return deployed;
}

function workerSecrets(s3: S3Settings, keys: S3Keys, secrets: LocalSecrets): Record<string, string> {
  const values: Record<string, string | null> = {
    WEBHOOK_PATH_SECRET: secrets.pathSecret,
    INFERENCE_WEBHOOK_ID: secrets.webhookId,
    S3_BUCKET: s3.bucket,
    S3_REGION: s3.region,
    S3_ACCESS_KEY_ID: keys.accessKeyId,
    S3_SECRET_ACCESS_KEY: keys.secretAccessKey,
    S3_KEY_PREFIX: s3.keyPrefix || null,
    S3_ENDPOINT: s3.endpoint,
  };
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== null));
}

async function setWebhookId(deps: Deps, deployment: Deployment, secrets: LocalSecrets, webhookId: string): Promise<void> {
  deps.out.step("Storing the webhook identifier");
  await putSecrets(deps.wrangler, deployment.name, { INFERENCE_WEBHOOK_ID: webhookId }, deployment.accountId);
  secrets.webhookId = webhookId;
  await deps.store.writeSecrets(deployment.name, secrets);
  deps.out.ok("The Worker now accepts deliveries for this webhook");
}

/** The Worker's own status report, or null when it does not answer. */
async function fetchStatus(deps: Deps, deployment: Deployment, secrets: LocalSecrets, probe: boolean): Promise<WorkerStatus | null> {
  try {
    const response = await deps.fetch(`${deployment.url}/${secrets.pathSecret}/status${probe ? "?probe=1" : ""}`, {
      signal: AbortSignal.timeout(30_000),
    });
    return response.ok ? ((await response.json()) as WorkerStatus) : null;
  } catch {
    return null;
  }
}

async function waitForWorker(deps: Deps, deployment: Deployment, secrets: LocalSecrets): Promise<WorkerStatus> {
  const deadline = deps.now().getTime() + WORKER_READY_TIMEOUT_MS;
  for (;;) {
    const workerStatus = await fetchStatus(deps, deployment, secrets, true);
    if (workerStatus) return workerStatus;
    if (deps.now().getTime() >= deadline) {
      throw new CliError(
        `The Worker did not answer at ${deployment.url} within ${WORKER_READY_TIMEOUT_MS / 1000} seconds.`,
        `Wait a minute, then run ${cli(`status ${deployment.name}`)}.`,
      );
    }
    await deps.sleep(POLL_INTERVAL_MS);
  }
}

function checkProbe(out: Output, workerStatus: WorkerStatus): void {
  if (!workerStatus.probe?.ok) {
    throw new CliError(
      `The Worker answers, but its S3 write failed: ${workerStatus.probe?.message ?? "S3 settings missing"}`,
      `Run ${cli("status <name>")} for details.`,
    );
  }
  out.ok(`The deployed Worker wrote ${workerStatus.probe.key}`);
}

async function waitForTestDelivery(deps: Deps, deployment: Deployment, secrets: LocalSecrets, since: Date): Promise<boolean> {
  deps.out.step(`Waiting up to ${TEST_DELIVERY_TIMEOUT_MS / 60_000} minutes for the test delivery`);
  const deadline = deps.now().getTime() + TEST_DELIVERY_TIMEOUT_MS;
  while (deps.now().getTime() < deadline) {
    const workerStatus = await fetchStatus(deps, deployment, secrets, false);
    const last = workerStatus?.lastDelivery;
    if (last?.event === "webhook.test" && new Date(last.at) >= since) {
      deps.out.ok(`Test delivery received and saved to ${last.key}`);
      return true;
    }
    const error = workerStatus?.lastError;
    if (error && new Date(error.at) >= since) {
      deps.out.fail(`The Worker rejected a delivery: HTTP ${error.status} ${error.message}`, errorFix(deployment.name, error.status));
      return false;
    }
    await deps.sleep(POLL_INTERVAL_MS);
  }
  deps.out.warn("No test delivery arrived.", `Click Test on the webhook, then run ${cli(`status ${deployment.name}`)}.`);
  return false;
}

function errorFix(name: string, statusCode: number): string {
  switch (statusCode) {
    case 401:
      return `The webhook identifier differs from the one the Worker has. Run ${cli(`config ${name} --webhook-id <identifier from the dashboard>`)}.`;
    case 404:
      return `The URL path is wrong. Run ${cli(`config ${name}`)} and register the webhook URL it shows.`;
    case 500:
      return `Settings are missing. Run ${cli(`status ${name}`)}.`;
    case 502:
      return `S3 refused the write. Run ${cli(`status ${name}`)}, and check the bucket and key permissions.`;
    default:
      return `Run ${cli(`logs ${name}`)} and retry.`;
  }
}

function ago(deps: Deps, iso: string): string {
  const seconds = Math.max(0, Math.round((deps.now().getTime() - new Date(iso).getTime()) / 1000));
  const text = seconds < 120 ? `${seconds}s` : seconds < 7200 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds / 3600)}h`;
  return `${text} ago (${iso})`;
}
