import { AwsClient } from "aws4fetch";

/** The subset of a Workers KV namespace this Worker uses. */
export interface StatusStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

/** Worker settings. See the configuration table in the README. */
export interface Env {
  WEBHOOK_PATH_SECRET: string;
  INFERENCE_WEBHOOK_ID: string;
  S3_BUCKET: string;
  S3_REGION: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  S3_KEY_PREFIX?: string;
  S3_ENDPOINT?: string;
  /** Optional KV binding. When present, the Worker records its last delivery and last error. */
  STATUS?: StatusStore;
}

export interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** What `GET /<WEBHOOK_PATH_SECRET>/status` returns. */
export interface WorkerStatus {
  missingSettings: string[];
  bucket: string | null;
  region: string | null;
  keyPrefix: string;
  endpoint: string | null;
  statusStore: boolean;
  lastDelivery: DeliveryRecord | null;
  lastError: ErrorRecord | null;
  probe: { ok: boolean; key: string; status: number; message: string } | null;
}

export interface DeliveryRecord {
  at: string;
  event: string;
  key: string;
}

export interface ErrorRecord {
  at: string;
  event: string | null;
  status: number;
  message: string;
}

const REQUIRED_SETTINGS = [
  "WEBHOOK_PATH_SECRET",
  "INFERENCE_WEBHOOK_ID",
  "S3_BUCKET",
  "S3_REGION",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

// Characters that need no URL encoding, so the signed path is the key as written.
export const SAFE_KEY_PREFIX = /^[A-Za-z0-9/_.-]*$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

// inference.net retries 5xx itself, so keep S3 retries short: the whole
// request must finish inside the platform's 30 second delivery timeout.
const S3_RETRIES = 3;

const LAST_DELIVERY_KEY = "last-delivery";
const LAST_ERROR_KEY = "last-error";

// KV allows about one write per second per key and bills per write, so each
// isolate records a delivery at most once a minute and an error at most every
// 10 seconds. Dashboard test events are always recorded.
const RECORD_INTERVAL_MS = { [LAST_DELIVERY_KEY]: 60_000, [LAST_ERROR_KEY]: 10_000 };
const lastRecordedAt = new Map<string, number>();

export default {
  async fetch(request: Request, env: Env, ctx: WorkerContext): Promise<Response> {
    if (!env.WEBHOOK_PATH_SECRET) {
      return reply(500, "Missing settings: WEBHOOK_PATH_SECRET");
    }
    const [, secret = "", action, ...rest] = new URL(request.url).pathname.split("/");
    if (!(await safeEqual(secret, env.WEBHOOK_PATH_SECRET)) || rest.length > 0) {
      return reply(404, "Not found");
    }
    if (action === "status" && request.method === "GET") {
      const probe = new URL(request.url).searchParams.get("probe") === "1";
      return Response.json(await workerStatus(env, probe));
    }
    if (action !== undefined) {
      return reply(404, "Not found");
    }
    if (request.method !== "POST") {
      return reply(405, "Method not allowed");
    }
    return handleDelivery(request, env, ctx);
  },
};

async function handleDelivery(request: Request, env: Env, ctx: WorkerContext): Promise<Response> {
  const event = request.headers.get("x-inference-event");
  const fail = (status: number, message: string): Response => {
    record(env, ctx, LAST_ERROR_KEY, { at: new Date().toISOString(), event, status, message }, false);
    return reply(status, message);
  };

  const missing = REQUIRED_SETTINGS.filter((name) => !env[name]);
  if (missing.length > 0) {
    console.error("Missing settings", missing);
    return fail(500, `Missing settings: ${missing.join(", ")}`);
  }
  const prefix = env.S3_KEY_PREFIX ?? "";
  if (!SAFE_KEY_PREFIX.test(prefix)) {
    return fail(500, "S3_KEY_PREFIX may only contain A-Z a-z 0-9 / _ . -");
  }
  const webhookId = request.headers.get("x-inference-webhook-id") ?? "";
  if (!(await safeEqual(webhookId, env.INFERENCE_WEBHOOK_ID))) {
    return fail(401, "X-Inference-Webhook-ID does not match INFERENCE_WEBHOOK_ID");
  }
  const key = objectKey(request.headers);
  if (!key) {
    return fail(400, "Unsupported event or missing id header");
  }

  const result = await putObject(env, `${prefix}${key}`, await request.arrayBuffer());
  if (!result.ok) {
    return fail(502, result.message);
  }
  record(
    env,
    ctx,
    LAST_DELIVERY_KEY,
    { at: new Date().toISOString(), event: event ?? "", key: `${prefix}${key}` },
    event === "webhook.test",
  );
  return reply(200, `${prefix}${key}`);
}

async function workerStatus(env: Env, probe: boolean): Promise<WorkerStatus> {
  const missingSettings = REQUIRED_SETTINGS.filter((name) => !env[name]);
  const prefix = env.S3_KEY_PREFIX ?? "";
  const canProbe =
    probe && SAFE_KEY_PREFIX.test(prefix) && !missingSettings.some((name) => name.startsWith("S3_"));
  const probeKey = `${prefix}tests/status-probe.json`;
  const probeResult = canProbe
    ? await putObject(env, probeKey, JSON.stringify({ probe: true, at: new Date().toISOString() }))
    : null;
  return {
    missingSettings,
    bucket: env.S3_BUCKET || null,
    region: env.S3_REGION || null,
    keyPrefix: prefix,
    endpoint: env.S3_ENDPOINT || null,
    statusStore: Boolean(env.STATUS),
    lastDelivery: await readRecord<DeliveryRecord>(env, LAST_DELIVERY_KEY),
    lastError: await readRecord<ErrorRecord>(env, LAST_ERROR_KEY),
    probe: probeResult && { key: probeKey, ...probeResult },
  };
}

/** PUTs one object. Never throws; the message says what S3 answered. */
async function putObject(
  env: Env,
  key: string,
  body: ArrayBuffer | string,
): Promise<{ ok: boolean; status: number; message: string }> {
  const s3 = new AwsClient({
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    service: "s3",
    region: env.S3_REGION,
    retries: S3_RETRIES,
  });
  const url = objectUrl(env, key);
  try {
    const response = await s3.fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (response.ok) {
      return { ok: true, status: response.status, message: "OK" };
    }
    const detail = (await response.text()).slice(0, 500);
    console.error("S3 PUT failed", url, response.status, detail);
    return { ok: false, status: response.status, message: `S3 PUT failed with HTTP ${response.status}: ${detail}` };
  } catch (error) {
    console.error("S3 PUT failed", url, error);
    return { ok: false, status: 0, message: `S3 PUT failed: ${String(error)}` };
  }
}

/**
 * The object key (before S3_KEY_PREFIX) for one delivery, or null for an
 * event this Worker does not store. Keys come from ids that stay the same on
 * every delivery attempt, so a retry overwrites the same object.
 */
export function objectKey(headers: Headers): string | null {
  const event = headers.get("x-inference-event");
  if (event === "webhook.test") {
    return "tests/webhook-test.json";
  }
  const [folder, id] =
    event === "slow-group.completed"
      ? ["groups", headers.get("x-inference-group-id")]
      : event === "generation.completed" || event === "async-embedding.completed"
        ? ["generations", headers.get("x-inference-generation-id")]
        : [null, null];
  return folder && id && SAFE_ID.test(id) ? `${folder}/${id}.json` : null;
}

/** Virtual-hosted URL on AWS; path-style on a custom endpoint (R2, MinIO). */
export function objectUrl(env: Pick<Env, "S3_BUCKET" | "S3_REGION" | "S3_ENDPOINT">, key: string): string {
  return env.S3_ENDPOINT
    ? `${env.S3_ENDPOINT.replace(/\/+$/, "")}/${env.S3_BUCKET}/${key}`
    : `https://${env.S3_BUCKET}.s3.${env.S3_REGION}.amazonaws.com/${key}`;
}

function record(
  env: Env,
  ctx: WorkerContext,
  key: typeof LAST_DELIVERY_KEY | typeof LAST_ERROR_KEY,
  value: DeliveryRecord | ErrorRecord,
  always: boolean,
): void {
  const store = env.STATUS;
  const now = Date.now();
  if (!store || (!always && now - (lastRecordedAt.get(key) ?? 0) < RECORD_INTERVAL_MS[key])) {
    return;
  }
  lastRecordedAt.set(key, now);
  ctx.waitUntil(
    store.put(key, JSON.stringify(value)).catch((error: unknown) => {
      console.warn("Could not write status to KV", key, error);
    }),
  );
}

async function readRecord<T>(env: Env, key: string): Promise<T | null> {
  const value = await env.STATUS?.get(key);
  return value ? (JSON.parse(value) as T) : null;
}

/**
 * Compares SHA-256 digests byte by byte, so the time taken does not show how
 * many leading characters of a secret matched.
 */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [x, y] = await Promise.all(
    [a, b].map(async (value) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))),
  );
  let diff = 0;
  x.forEach((byte, index) => {
    diff |= byte ^ (y[index] ?? 0);
  });
  return diff === 0;
}

function reply(status: number, body: string): Response {
  return new Response(body, { status });
}
