import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as commands from "../cli/commands";
import { CliError, command, detectPackageManager, Output } from "../cli/output";
import type { Prompter } from "../cli/prompt";
import { probeS3Write } from "../cli/s3";
import { type Deployment, StateStore, workerNameError } from "../cli/state";
import type { Wrangler, WranglerOptions, WranglerResult } from "../cli/wrangler";
import type { WorkerStatus } from "../src/index";

const ACCOUNT = { id: "0123456789abcdef0123456789abcdef", name: "Example account" };
const NAMESPACE_ID = "fedcba9876543210fedcba9876543210";
const WORKER_URL = "https://my-results.example.workers.dev";

let dir: string;
let store: StateStore;
let lines: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "webhook-s3-"));
  store = new StateStore(dir);
  lines = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

type Call = { args: string[]; options: WranglerOptions };

/** A wrangler stand-in: answers by command, and records every call. */
function fakeWrangler(overrides: Record<string, Partial<WranglerResult>> = {}): { wrangler: Wrangler; calls: Call[] } {
  const calls: Call[] = [];
  const defaults: Record<string, Partial<WranglerResult>> = {
    "--version": { stdout: "4.157.0\n" },
    whoami: { stdout: JSON.stringify({ loggedIn: true, accounts: [ACCOUNT] }) },
    "deployments status": { code: 1, stderr: "This Worker does not exist on your account. [code: 10007]" },
    "kv namespace": { stdout: `{\n  "kv_namespaces": [{ "binding": "x", "id": "${NAMESPACE_ID}" }]\n}` },
    deploy: { stdout: `Uploaded my-results\nDeployed my-results triggers\n  ${WORKER_URL}\n` },
  };
  const wrangler: Wrangler = async (args, options = {}) => {
    calls.push({ args, options });
    const key = [args.slice(0, 2).join(" "), args[0] ?? ""].find((candidate) => candidate in overrides || candidate in defaults);
    const answer = key ? (overrides[key] ?? defaults[key]) : {};
    return { code: 0, stdout: "", stderr: "", ...answer };
  };
  return { wrangler, calls };
}

function healthyStatus(overrides: Partial<WorkerStatus> = {}): WorkerStatus {
  return {
    missingSettings: [],
    bucket: "results",
    region: "us-east-1",
    keyPrefix: "embeddings/",
    endpoint: null,
    statusStore: true,
    lastDelivery: { at: "2026-01-01T00:00:00.000Z", event: "webhook.test", key: "embeddings/tests/webhook-test.json" },
    lastError: null,
    probe: { ok: true, key: "embeddings/tests/status-probe.json", status: 200, message: "OK" },
    ...overrides,
  };
}

function makeDeps(overrides: Partial<commands.Deps> = {}): commands.Deps {
  return {
    wrangler: fakeWrangler().wrangler,
    store,
    out: new Output(false, (line) => lines.push(line)),
    prompt: null,
    fetch: vi.fn(async () => Response.json(healthyStatus())),
    env: {},
    nodeVersion: "24.14.1",
    compatibilityDate: "2026-11-01",
    sleep: async () => {},
    now: () => new Date("2026-01-01T00:01:00.000Z"),
    ...overrides,
  };
}

const setupFlags: commands.SetupOptions = {
  bucket: "results",
  region: "us-east-1",
  prefix: "embeddings",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "s3-secret",
};

async function seed(name = "my-results", webhookId: string | null = "AhALzdz8S"): Promise<Deployment> {
  const deployment: Deployment = {
    name,
    accountId: ACCOUNT.id,
    url: WORKER_URL,
    statusNamespaceId: NAMESPACE_ID,
    s3: { bucket: "results", region: "us-east-1", keyPrefix: "embeddings/", endpoint: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  await store.write(deployment);
  await store.writeSecrets(name, { pathSecret: "path-secret", webhookId });
  return deployment;
}

describe("workerNameError", () => {
  it.each(["a", "my-results", "results-2026", "a".repeat(63)])("accepts %s", (name) => {
    expect(workerNameError(name)).toBeNull();
  });

  it.each(["", "My-Results", "-results", "results-", "my_results", "my.results", "a".repeat(64)])("rejects %s", (name) => {
    expect(workerNameError(name)).toMatch(/not a valid Worker name/);
  });
});

describe("StateStore", () => {
  it("round-trips state, keeps secrets in an owner-only file, and lists only state files", async () => {
    const deployment = await seed("b-worker");
    await seed("a-worker");
    await store.writeWranglerConfig(deployment, "2026-11-01");

    expect(await store.read("b-worker")).toEqual(deployment);
    expect(await store.readSecrets("b-worker")).toEqual({ pathSecret: "path-secret", webhookId: "AhALzdz8S" });
    expect((await stat(store.secretsPath("b-worker"))).mode & 0o777).toBe(0o600);
    expect((await store.list()).map(({ name }) => name)).toEqual(["a-worker", "b-worker"]);
    expect(await readFile(store.statePath("b-worker"), "utf8")).not.toMatch(/path-secret|AhALzdz8S/);
  });

  it("writes a Wrangler config with the name and the status KV binding", async () => {
    const path = await store.writeWranglerConfig(await seed(), "2026-11-01");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      name: "my-results",
      main: "../src/index.ts",
      compatibility_date: "2026-11-01",
      kv_namespaces: [{ binding: "STATUS", id: NAMESPACE_ID }],
    });
  });

  it("returns null and an empty list when nothing exists", async () => {
    const empty = new StateStore(join(dir, "missing"));
    expect(await empty.read("x")).toBeNull();
    expect(await empty.list()).toEqual([]);
  });

  it("removes every file of one deployment", async () => {
    await store.writeWranglerConfig(await seed(), "2026-11-01");
    await store.remove("my-results");
    expect(await store.read("my-results")).toBeNull();
    expect(await store.readSecrets("my-results")).toBeNull();
  });
});

describe("setup", () => {
  it("probes S3, creates KV, deploys, stores secrets over stdin, and saves state without S3 keys", async () => {
    const s3 = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const { wrangler, calls } = fakeWrangler();
    const result = await commands.setup(makeDeps({ wrangler }), "my-results", { ...setupFlags, webhookId: "AhALzdz8S" });
    if (!("webhookUrl" in result)) throw new Error("expected a full setup result");

    expect(result).toMatchObject({ ok: true, url: WORKER_URL, webhookIdSet: true, s3: { keyPrefix: "embeddings/" } });
    expect(result.webhookUrl).toMatch(new RegExp(`^${WORKER_URL}/[0-9a-f]{64}$`));
    expect((s3.mock.calls[0]?.[0] as Request).url).toBe("https://results.s3.us-east-1.amazonaws.com/embeddings/tests/setup-probe.json");
    expect(calls.map(({ args }) => args.slice(0, 2).join(" "))).toEqual([
      "--version",
      "whoami --json",
      "deployments status",
      "kv namespace",
      "deploy --config",
      "secret bulk",
    ]);
    const bulk = calls.at(-1)!;
    expect(bulk.options.accountId).toBe(ACCOUNT.id);
    expect(JSON.parse(bulk.options.input ?? "{}")).toEqual({
      WEBHOOK_PATH_SECRET: result.webhookUrl.split("/").pop(),
      INFERENCE_WEBHOOK_ID: "AhALzdz8S",
      S3_BUCKET: "results",
      S3_REGION: "us-east-1",
      S3_ACCESS_KEY_ID: "AKIDEXAMPLE",
      S3_SECRET_ACCESS_KEY: "s3-secret",
      S3_KEY_PREFIX: "embeddings/",
    });
    const saved = await readFile(store.statePath("my-results"), "utf8");
    expect(saved).not.toMatch(/AKIDEXAMPLE|s3-secret/);
    expect(JSON.parse(saved)).toMatchObject({ url: WORKER_URL, statusNamespaceId: NAMESPACE_ID });
  });

  it("uses the R2 endpoint of the chosen account", async () => {
    const s3 = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    await commands.setup(makeDeps(), "my-results", { ...setupFlags, region: undefined, storage: "r2" });
    expect((s3.mock.calls[0]?.[0] as Request).url).toBe(
      `https://${ACCOUNT.id}.r2.cloudflarestorage.com/results/embeddings/tests/setup-probe.json`,
    );
  });

  it("finds the region of an Amazon S3 bucket when --region is not given", async () => {
    const s3 = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const lookup = vi.fn(async () => new Response(null, { status: 301, headers: { "x-amz-bucket-region": "us-west-2" } }));
    const result = await commands.setup(makeDeps({ fetch: lookup }), "my-results", { ...setupFlags, region: undefined, dryRun: true });
    expect(lookup).toHaveBeenCalledWith("https://s3.amazonaws.com/results", expect.objectContaining({ method: "HEAD" }));
    expect(result).toMatchObject({ s3: { region: "us-west-2" } });
    expect((s3.mock.calls[0]?.[0] as Request).url).toBe("https://results.s3.us-west-2.amazonaws.com/embeddings/tests/setup-probe.json");
  });

  it("deploys again when Cloudflare says the just-uploaded Worker does not exist", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const { wrangler: base, calls } = fakeWrangler();
    let deploys = 0;
    const wrangler: Wrangler = async (args, options) => {
      if (args[0] === "deploy" && ++deploys === 1) {
        return { code: 1, stdout: "Uploaded my-results", stderr: "\u001b[31mThis Worker does not exist on your account. [code: 10007]\u001b[0m" };
      }
      return base(args, options);
    };
    const result = await commands.setup(makeDeps({ wrangler }), "my-results", setupFlags);
    expect(result).toMatchObject({ ok: true, url: WORKER_URL });
    expect(deploys).toBe(2);
    expect(calls.at(-1)?.args.slice(0, 2)).toEqual(["secret", "bulk"]);
  });

  it("says how to start over when it fails after creating resources", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const { wrangler } = fakeWrangler({ deploy: { code: 1, stderr: "\u001b[31mAuthentication error [code: 10000]\u001b[0m" } });
    const error = await commands.setup(makeDeps({ wrangler }), "my-results", setupFlags).catch((caught) => caught);
    expect(error.message).toBe("wrangler deploy failed: Authentication error [code: 10000]");
    expect(error.fix).toMatch(/destroy my-results --yes/);
  });

  it("waits for any dashboard test event, not only webhook.test", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const delivered = healthyStatus({
      lastDelivery: { at: "2026-01-01T00:01:00.000Z", event: "slow-group.completed", key: "embeddings/groups/test-group-1.json" },
    });
    const prompt: Prompter = {
      input: async () => "",
      password: async () => "",
      confirm: async () => true,
      select: async <T extends string>(_message: string, choices: Array<{ value: T }>) => choices[0]!.value,
    };
    const result = await commands.setup(
      makeDeps({ prompt, fetch: vi.fn(async () => Response.json(delivered)) }),
      "my-results",
      { ...setupFlags, webhookId: "AhALzdz8S" },
    );
    expect(result).toMatchObject({ testDelivery: true });
    expect(lines.join("\n")).toContain("slow-group.completed delivery received");
  });

  it("refuses a name that already exists in the Cloudflare account", async () => {
    const { wrangler, calls } = fakeWrangler({ "deployments status": { code: 0, stdout: "{}" } });
    await expect(commands.setup(makeDeps({ wrangler }), "my-results", setupFlags)).rejects.toThrow(/already exists/);
    expect(calls.some(({ args }) => args[0] === "deploy")).toBe(false);
  });

  it("refuses an invalid name before it calls Cloudflare", async () => {
    const { wrangler, calls } = fakeWrangler();
    await expect(commands.setup(makeDeps({ wrangler }), "My_Worker", setupFlags)).rejects.toThrow(/not a valid Worker name/);
    expect(calls.some(({ args }) => args[0] === "deployments")).toBe(false);
  });

  it("refuses a name already set up from this folder", async () => {
    await seed();
    await expect(commands.setup(makeDeps(), "my-results", setupFlags)).rejects.toThrow(/already set up/);
  });

  it("names the missing flag when it cannot ask", async () => {
    const error = await commands.setup(makeDeps(), "my-results", { ...setupFlags, bucket: undefined }).catch((caught) => caught);
    expect(error).toBeInstanceOf(CliError);
    expect(error.fix).toMatch(/--bucket/);
  });

  it("explains how to log in when wrangler is not logged in", async () => {
    const { wrangler } = fakeWrangler({ whoami: { code: 1, stdout: "" } });
    await expect(commands.setup(makeDeps({ wrangler }), "my-results", setupFlags)).rejects.toMatchObject({
      message: "Not logged in to Cloudflare.",
      fix: expect.stringMatching(/wrangler login/),
    });
  });

  it("does not deploy when the S3 key cannot write", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 }),
    );
    const { wrangler, calls } = fakeWrangler();
    await expect(commands.setup(makeDeps({ wrangler }), "my-results", setupFlags)).rejects.toMatchObject({
      fix: expect.stringMatching(/s3:PutObject/),
    });
    expect(calls.some(({ args }) => args[0] === "deploy" || args[0] === "kv")).toBe(false);
  });

  it("asks for each value in a terminal and stores a pasted webhook identifier", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const { wrangler, calls } = fakeWrangler();
    const answers = ["my-results", "results", "us-east-1", "", "AKIDEXAMPLE", "AhALzdz8S"];
    const prompt: Prompter = {
      // An empty inference.net API key skips the API and uses the dashboard.
      password: async (message) => (message.startsWith("inference.net API key") ? "" : "s3-secret"),
      input: async () => answers.shift() ?? "",
      confirm: async () => false,
      select: async <T extends string>(_message: string, choices: Array<{ value: T }>) => choices[0]!.value,
    };
    const result = await commands.setup(makeDeps({ wrangler, prompt }), undefined, {});
    expect(result).toMatchObject({ name: "my-results", webhookIdSet: true });
    expect(JSON.parse(calls.at(-1)!.options.input ?? "{}")).toEqual({ INFERENCE_WEBHOOK_ID: "AhALzdz8S" });
    expect(await store.readSecrets("my-results")).toMatchObject({ webhookId: "AhALzdz8S" });
  });
});

describe("status", () => {
  it("passes every check for a healthy Worker", async () => {
    await seed();
    const fetchWorker = vi.fn(async () => Response.json(healthyStatus()));
    const { wrangler } = fakeWrangler({ "deployments status": { code: 0, stdout: "{}" } });
    const result = await commands.status(makeDeps({ wrangler, fetch: fetchWorker }), "my-results");
    expect(result.ok).toBe(true);
    expect(result.checks.map(({ check, ok }) => [check, ok])).toEqual([
      ["deployed", true],
      ["reachable", true],
      ["settings", true],
      ["s3", true],
      ["deliveries", true],
    ]);
    expect(fetchWorker).toHaveBeenCalledWith(`${WORKER_URL}/path-secret/status?probe=1`, expect.anything());
  });

  it("fails with a fix when S3 writes fail and the webhook id is missing", async () => {
    await seed();
    const fetchWorker = vi.fn(async () =>
      Response.json(
        healthyStatus({
          missingSettings: ["INFERENCE_WEBHOOK_ID"],
          probe: { ok: false, key: "k", status: 403, message: "S3 PUT failed with HTTP 403" },
          lastError: { at: "2026-01-01T00:00:30.000Z", event: "webhook.test", status: 401, message: "mismatch" },
        }),
      ),
    );
    const { wrangler } = fakeWrangler({ "deployments status": { code: 0, stdout: "{}" } });
    const result = await commands.status(makeDeps({ wrangler, fetch: fetchWorker }), "my-results");
    expect(result.ok).toBe(false);
    expect(result.checks.find(({ check }) => check === "settings")?.fix).toMatch(/--webhook-id/);
    expect(result.checks.find(({ check }) => check === "last-error")?.fix).toMatch(/--webhook-id/);
    expect(lines.join("\n")).toMatch(/needs attention/);
  });

  it("fails when deliveries fail now, such as at an old webhook URL", async () => {
    await seed();
    const fetchWorker = vi.fn(async () =>
      Response.json(
        healthyStatus({
          lastError: { at: "2026-01-01T00:00:30.000Z", event: "slow-group.completed", status: 404, message: "Wrong path" },
        }),
      ),
    );
    const { wrangler } = fakeWrangler({ "deployments status": { code: 0, stdout: "{}" } });
    const result = await commands.status(makeDeps({ wrangler, fetch: fetchWorker }), "my-results");
    expect(result.ok).toBe(false);
    expect(result.checks.find(({ check }) => check === "last-error")?.fix).toMatch(/register the webhook URL/);
  });

  it("reports an unknown name with the commands that help", async () => {
    await expect(commands.status(makeDeps(), "nope")).rejects.toMatchObject({ fix: expect.stringMatching(/list/) });
  });
});

describe("test", () => {
  it("sends a webhook.test delivery with the webhook headers and reports the S3 key", async () => {
    await seed();
    const fetchWorker = vi.fn(async () => new Response("embeddings/tests/webhook-test.json"));
    const result = await commands.test(makeDeps({ fetch: fetchWorker }), "my-results");
    expect(result).toEqual({ ok: true, name: "my-results", bucket: "results", key: "embeddings/tests/webhook-test.json" });
    const [url, init] = fetchWorker.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${WORKER_URL}/path-secret`);
    expect(init.headers).toMatchObject({ "X-Inference-Event": "webhook.test", "X-Inference-Webhook-ID": "AhALzdz8S" });
  });

  it("turns a 502 into an S3 fix", async () => {
    await seed();
    const fetchWorker = vi.fn(async () => new Response("S3 PUT failed with HTTP 403", { status: 502 }));
    await expect(commands.test(makeDeps({ fetch: fetchWorker }), "my-results")).rejects.toMatchObject({
      fix: expect.stringMatching(/S3 refused/),
    });
  });

  it("needs a webhook identifier first", async () => {
    await seed("my-results", null);
    await expect(commands.test(makeDeps(), "my-results")).rejects.toThrow(/no webhook identifier/);
  });
});

describe("config", () => {
  it("stores a new webhook identifier and a cleared prefix in one secret update", async () => {
    await seed("my-results", null);
    const { wrangler, calls } = fakeWrangler();
    const result = await commands.config(makeDeps({ wrangler }), "my-results", { webhookId: "NewId123", prefix: "" });
    expect(result).toMatchObject({ ok: true, changed: ["S3_KEY_PREFIX", "INFERENCE_WEBHOOK_ID"] });
    expect(calls[0]?.args).toEqual(["secret", "bulk", "--name", "my-results"]);
    expect(JSON.parse(calls[0]?.options.input ?? "{}")).toEqual({ S3_KEY_PREFIX: null, INFERENCE_WEBHOOK_ID: "NewId123" });
    expect(await store.readSecrets("my-results")).toMatchObject({ webhookId: "NewId123" });
    expect((await store.read("my-results"))?.s3.keyPrefix).toBe("");
  });

  it("rotates the path secret and prints the new URL to register", async () => {
    await seed();
    const result = await commands.config(makeDeps(), "my-results", { rotatePathSecret: true });
    const secrets = await store.readSecrets("my-results");
    expect(secrets?.pathSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(result.webhookUrl).toBe(`${WORKER_URL}/${secrets?.pathSecret}`);
    expect(lines.join("\n")).toMatch(/webhook URL changed/);
  });

  it("shows settings without changing anything", async () => {
    await seed();
    const { wrangler, calls } = fakeWrangler();
    const result = await commands.config(makeDeps({ wrangler }), "my-results", {});
    expect(result).toMatchObject({ name: "my-results", webhookUrl: `${WORKER_URL}/path-secret` });
    expect(calls).toEqual([]);
  });
});

describe("destroy", () => {
  it("refuses without confirmation when it cannot ask", async () => {
    await seed();
    const { wrangler, calls } = fakeWrangler();
    await expect(commands.destroy(makeDeps({ wrangler }), "my-results", {})).rejects.toThrow(/needs confirmation/);
    expect(calls).toEqual([]);
  });

  it("refuses when the typed name does not match", async () => {
    await seed();
    const prompt = { input: async () => "other" } as unknown as Prompter;
    await expect(commands.destroy(makeDeps({ prompt }), "my-results", {})).rejects.toThrow(/did not match/);
    expect(await store.read("my-results")).not.toBeNull();
  });

  it("deletes the Worker, the KV namespace, and local state with --yes", async () => {
    await seed();
    const { wrangler, calls } = fakeWrangler();
    await commands.destroy(makeDeps({ wrangler }), "my-results", { yes: true });
    expect(calls.map(({ args }) => args)).toEqual([
      ["delete", "my-results"],
      ["kv", "namespace", "delete", "--namespace-id", NAMESPACE_ID, "--skip-confirmation"],
    ]);
    expect(await store.read("my-results")).toBeNull();
  });
});

describe("inference.net webhook API", () => {
  const API = "https://relay.inference.net/api/rest";
  const API_KEY = "inf-test-key";
  const WEBHOOK = {
    id: "0c6f6a1e-6c1b-4a0e-9a53-2f1f4d0e8b7a",
    name: "my-results",
    identifier: "AhALzdz8S",
    teamId: "team_123",
    url: `${WORKER_URL}/path-secret`,
    isDisabled: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  type ApiCall = { method: string; url: string; body: unknown; auth: string | null };

  /** A fetch stand-in: the API answers from `routes` ("METHOD /path"), the Worker's status URL answers healthy. */
  function apiFetch(routes: Record<string, () => Response>) {
    const calls: ApiCall[] = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      if (!url.startsWith(API)) {
        return Response.json(healthyStatus({ lastDelivery: { at: "2026-01-01T00:01:00.000Z", event: "webhook.test", key: "embeddings/tests/webhook-test.json" } }));
      }
      const method = init.method ?? "GET";
      calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined, auth: new Headers(init.headers).get("authorization") });
      const route = routes[`${method} ${url.slice(API.length).split("?")[0]}`];
      return route ? route() : Response.json({ code: "NOT_FOUND", message: "Not found" }, { status: 404 });
    });
    return { fetchFn, calls };
  }

  async function seedFromApi(): Promise<void> {
    const deployment = await seed();
    await store.write({ ...deployment, apiWebhookId: WEBHOOK.id });
  }

  it("setup creates the webhook, stores its identifier, and has inference.net send a test delivery", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const { wrangler, calls: wranglerCalls } = fakeWrangler();
    const { fetchFn, calls } = apiFetch({
      "GET /webhooks": () => Response.json({ webhooks: [], total: 0 }),
      "POST /webhooks": () => Response.json({ webhook: WEBHOOK }),
      [`POST /webhooks/${WEBHOOK.id}/test`]: () => Response.json({ success: true, statusCode: 200 }),
    });
    const result = await commands.setup(makeDeps({ wrangler, fetch: fetchFn, env: { INFERENCE_API_KEY: API_KEY } }), "my-results", setupFlags);
    if (!("webhookUrl" in result)) throw new Error("expected a full setup result");

    expect(result).toMatchObject({ webhookIdSet: true, webhookCreated: true, testDelivery: true });
    expect(calls.map(({ method, url }) => `${method} ${url.slice(API.length)}`)).toEqual([
      "GET /webhooks?limit=1",
      "POST /webhooks",
      `POST /webhooks/${WEBHOOK.id}/test`,
    ]);
    expect(calls.every(({ auth }) => auth === `Bearer ${API_KEY}`)).toBe(true);
    expect(calls[1]?.body).toEqual({ url: result.webhookUrl, name: "my-results" });
    expect(JSON.parse(wranglerCalls.at(-1)!.options.input ?? "{}")).toEqual({ INFERENCE_WEBHOOK_ID: WEBHOOK.identifier });
    expect(await store.read("my-results")).toMatchObject({ apiWebhookId: WEBHOOK.id });
    expect(await store.readSecrets("my-results")).toMatchObject({ webhookId: WEBHOOK.identifier });
    for (const path of [store.statePath("my-results"), store.secretsPath("my-results")]) {
      expect(await readFile(path, "utf8")).not.toContain(API_KEY);
    }
    expect(lines.join("\n")).not.toContain(API_KEY);
    expect(lines.join("\n")).not.toContain("Create Webhook");
  });

  it("setup falls back to the dashboard when the API answers 404", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const { fetchFn, calls } = apiFetch({});
    const result = await commands.setup(makeDeps({ fetch: fetchFn, env: { INFERENCE_API_KEY: API_KEY } }), "my-results", setupFlags);
    expect(result).toMatchObject({ webhookIdSet: false, webhookCreated: false });
    expect(calls.map(({ method }) => method)).toEqual(["GET"]);
    expect(lines.join("\n")).toMatch(/webhook API is not available yet[\s\S]*Settings → Integrations → Create Webhook/);
  });

  it("setup stops before it creates anything when the API key is refused", async () => {
    const { wrangler, calls } = fakeWrangler();
    const { fetchFn } = apiFetch({ "GET /webhooks": () => Response.json({ code: "UNAUTHORIZED", message: "Invalid API key" }, { status: 401 }) });
    const error = await commands
      .setup(makeDeps({ wrangler, fetch: fetchFn, env: { INFERENCE_API_KEY: API_KEY } }), "my-results", setupFlags)
      .catch((caught) => caught);
    expect(error.message).toBe("inference.net API answered HTTP 401: Invalid API key");
    expect(error.fix).toMatch(/write access, created by a team owner or admin/);
    expect(calls.some(({ args }) => args[0] === "kv" || args[0] === "deploy")).toBe(false);
  });

  it("config --rotate-path-secret sets the new URL on the webhook", async () => {
    await seedFromApi();
    const { fetchFn, calls } = apiFetch({ [`PATCH /webhooks/${WEBHOOK.id}`]: () => Response.json({ webhook: WEBHOOK }) });
    const result = await commands.config(makeDeps({ fetch: fetchFn, env: { INFERENCE_API_KEY: API_KEY } }), "my-results", { rotatePathSecret: true });
    expect(calls).toMatchObject([{ method: "PATCH", body: { url: result.webhookUrl } }]);
    expect(result.webhookUrl).not.toBe(`${WORKER_URL}/path-secret`);
    expect(lines.join("\n")).not.toMatch(/In the inference.net dashboard/);
  });

  it("destroy --yes deletes the webhook before the Worker", async () => {
    await seedFromApi();
    const { wrangler } = fakeWrangler();
    const { fetchFn, calls } = apiFetch({ [`DELETE /webhooks/${WEBHOOK.id}`]: () => Response.json({ success: true }) });
    const result = await commands.destroy(makeDeps({ wrangler, fetch: fetchFn, env: { INFERENCE_API_KEY: API_KEY } }), "my-results", { yes: true });
    expect(result).toMatchObject({ webhook: "deleted", worker: "deleted" });
    expect(calls.map(({ method }) => method)).toEqual(["DELETE"]);
  });

  it("destroy without INFERENCE_API_KEY keeps the webhook and says to delete it in the dashboard", async () => {
    await seedFromApi();
    const { fetchFn, calls } = apiFetch({});
    const result = await commands.destroy(makeDeps({ fetch: fetchFn }), "my-results", { yes: true });
    expect(result).toMatchObject({ webhook: "kept" });
    expect(calls).toEqual([]);
    expect(lines.join("\n")).toMatch(/Delete webhook AhALzdz8S in the inference.net dashboard/);
  });

  it("status fails when the webhook sends to another URL", async () => {
    await seedFromApi();
    const { wrangler } = fakeWrangler({ "deployments status": { code: 0, stdout: "{}" } });
    const { fetchFn } = apiFetch({ [`GET /webhooks/${WEBHOOK.id}`]: () => Response.json({ webhook: { ...WEBHOOK, url: `${WORKER_URL}/old` } }) });
    const result = await commands.status(makeDeps({ wrangler, fetch: fetchFn, env: { INFERENCE_API_KEY: API_KEY } }), "my-results");
    expect(result.ok).toBe(false);
    expect(result.checks.find(({ check }) => check === "webhook")?.fix).toMatch(/--rotate-path-secret/);
  });

  it("test --remote has inference.net send a delivery and reports the Worker's answer", async () => {
    await seedFromApi();
    const { fetchFn } = apiFetch({
      [`POST /webhooks/${WEBHOOK.id}/test`]: () => Response.json({ success: false, statusCode: 502, error: "HTTP 502" }),
    });
    const result = await commands.test(makeDeps({ fetch: fetchFn, env: { INFERENCE_API_KEY: API_KEY } }), "my-results", { remote: true });
    expect(result).toEqual({ ok: false, name: "my-results", remote: true });
    expect(lines.join("\n")).toMatch(/answered HTTP 502[\s\S]*S3 refused/);
  });

  it("test --remote without INFERENCE_API_KEY points at the dashboard", async () => {
    await seedFromApi();
    await expect(commands.test(makeDeps(), "my-results", { remote: true })).rejects.toMatchObject({
      fix: expect.stringMatching(/choose Test Webhook/),
    });
  });
});

describe("list", () => {
  it("lists Workers set up from this folder", async () => {
    await seed("b-worker");
    await seed("a-worker");
    const result = await commands.list(makeDeps());
    expect(result.map(({ name }) => name)).toEqual(["a-worker", "b-worker"]);
  });
});

describe("probeS3Write", () => {
  it("names the right region when the bucket lives elsewhere", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<Error><Code>PermanentRedirect</Code></Error>", {
        status: 301,
        headers: { "x-amz-bucket-region": "eu-west-1" },
      }),
    );
    await expect(
      probeS3Write({ bucket: "results", region: "us-east-1", keyPrefix: "", endpoint: null }, { accessKeyId: "a", secretAccessKey: "b" }),
    ).rejects.toMatchObject({ fix: "Use region eu-west-1." });
  });
});

describe("probeS3Write on an S3-compatible endpoint", () => {
  it("does not point at AWS IAM when an R2 key cannot write", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 }));
    const error = await probeS3Write(
      { bucket: "results", region: "auto", keyPrefix: "", endpoint: "https://account.r2.cloudflarestorage.com" },
      { accessKeyId: "a", secretAccessKey: "b" },
    ).catch((caught) => caught);
    expect(error.fix).toMatch(/Object Read & Write/);
    expect(error.fix).not.toMatch(/arn:aws/);
  });
});

describe("Output", () => {
  it("prints only the JSON result in --json mode", () => {
    const written: string[] = [];
    const out = new Output(true, (line) => written.push(line));
    out.step("hidden");
    out.result({ ok: true });
    out.error(new CliError("broken", "fix it"));
    expect(written.map((line) => JSON.parse(line))).toEqual([{ ok: true }, { ok: false, error: "broken", fix: "fix it" }]);
  });
});

describe("setup --dry-run", () => {
  it("runs the checks and the S3 probe but changes nothing in Cloudflare", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const { wrangler, calls } = fakeWrangler();
    const result = await commands.setup(makeDeps({ wrangler }), "my-results", { ...setupFlags, dryRun: true });
    expect(result).toMatchObject({ ok: true, dryRun: true });
    expect(calls.map(({ args }) => args[0])).toEqual(["--version", "whoami", "deployments"]);
    expect(await store.read("my-results")).toBeNull();
  });
});

describe("detectPackageManager", () => {
  it.each([
    ["npm/11.11.0 node/v24.14.1 linux x64 workspaces/false", "npm"],
    ["pnpm/9.9.0 npm/? node/v24.14.1 linux x64", "pnpm"],
    ["yarn/1.22.22 npm/? node/v24.14.1 linux x64", "yarn"],
    ["yarn/4.18.1 npm/? node/v24.14.1 linux x64", "yarn"],
    ["bun/1.4.4 npm/? node/v26.3.0 linux x64", "bun"],
    [undefined, "npm"],
    ["", "npm"],
    ["deno/2.0.0", "npm"],
  ] as const)("%s → %s", (userAgent, expected) => {
    expect(detectPackageManager(userAgent)).toBe(expected);
  });

  it("prints commands in the form each package manager runs them", () => {
    expect(command("status x --json", "npm")).toBe("npm run cli -- status x --json");
    expect(command("status x --json", "pnpm")).toBe("pnpm cli status x --json");
    expect(command("status x --json", "yarn")).toBe("yarn cli status x --json");
    expect(command("status x --json", "bun")).toBe("bun run cli status x --json");
  });
});

describe("CLI process", () => {
  /** Runs cli/main.ts like a package manager would, with no color settings inherited from the test runner. */
  function runCli(args: string[], env: Record<string, string> = {}) {
    const { FORCE_COLOR: _force, NO_COLOR: _no, npm_config_user_agent: _agent, ...base } = process.env;
    const result = spawnSync(process.execPath, [join(import.meta.dirname, "../cli/main.ts"), ...args], {
      env: { ...base, ...env },
      encoding: "utf8",
    });
    return { code: result.status, output: result.stdout + result.stderr };
  }
  const MISSING = "no-such-worker-for-tests";

  it("shows examples and exit codes in root help, in the launching package manager's form", () => {
    const { code, output } = runCli(["--help"], { npm_config_user_agent: "pnpm/9.9.0 npm/? node/v24.14.1" });
    expect(code).toBe(0);
    expect(output).toContain("pnpm cli setup");
    expect(output).not.toContain("npm run cli");
    expect(output).toMatch(/Exit codes:[\s\S]*2 +usage error/);
  });

  it.each(["setup", "status", "test", "logs", "config", "update", "list", "destroy"])("shows examples in %s --help", (name) => {
    const { code, output } = runCli([name, "--help"]);
    expect(code).toBe(0);
    expect(output).toContain("Examples:");
    expect(output).toContain(`npm run cli -- ${name}`);
  });

  it("lists the global flags and the package manager's command form in subcommand help", () => {
    const { output } = runCli(["status", "--help"], { npm_config_user_agent: "yarn/1.22.22 npm/? node/v24.14.1" });
    expect(output).toContain("Usage: yarn cli status [options] <name>");
    expect(output).toMatch(/Global Options:[\s\S]*--json[\s\S]*--yes[\s\S]*--no-color/);
  });

  it.each([
    ["no command (prints help)", [], 0],
    ["an unknown command", ["bogus"], 2],
    ["an unknown flag", ["list", "--bogus"], 2],
    ["a missing argument", ["status"], 2],
    ["an invalid Worker name", ["setup", "Not_Valid", "--yes"], 2],
    ["a Worker that is not set up", ["status", MISSING], 1],
  ] as const)("exits with the documented code for %s", (_case, args, expected) => {
    expect(runCli([...args]).code).toBe(expected);
  });

  it("names the fix on an error", () => {
    expect(runCli(["status", MISSING]).output).toMatch(/Fix: Run npm run cli -- list/);
  });

  it("uses color only when allowed", () => {
    const escape = /\u001b\[/;
    expect(runCli(["status", MISSING], { FORCE_COLOR: "1" }).output).toMatch(escape);
    expect(runCli(["status", MISSING, "--no-color"], { FORCE_COLOR: "1" }).output).not.toMatch(escape);
    expect(runCli(["status", MISSING], { NO_COLOR: "1" }).output).not.toMatch(escape);
    expect(runCli(["status", MISSING]).output).not.toMatch(escape);
  });

  it("prints only JSON on stdout with --json, errors included", () => {
    const result = spawnSync(process.execPath, [join(import.meta.dirname, "../cli/main.ts"), "status", MISSING, "--json"], {
      env: { ...process.env, FORCE_COLOR: "1" },
      encoding: "utf8",
    });
    expect(result.stdout).not.toMatch(/\u001b\[/);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, fix: expect.stringContaining("list") });
  });
});
