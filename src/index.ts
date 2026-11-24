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
  /**
   * Optional R2 bucket and queue for buffered mode. With both bound, a delivery is acknowledged once it is
   * staged in R2 and queued; the queue consumer then copies it to S3. With neither, the Worker writes to S3 directly.
   */
  STAGING?: StagingBucket;
  DELIVERIES?: DeliveryQueue;
}

/** The subset of an R2 bucket binding this Worker uses. */
export interface StagingBucket {
  put(key: string, value: ArrayBuffer, options: { customMetadata: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<StagedObject | null>;
  head(key: string): Promise<{ etag: string } | null>;
  delete(key: string): Promise<void>;
  list(options: { limit: number; cursor?: string }): Promise<{
    objects: Array<{ key: string; uploaded: Date }>;
    truncated: boolean;
    cursor?: string;
  }>;
}

export interface StagedObject {
  etag: string;
  body: ReadableStream;
  checksums: { md5?: ArrayBuffer };
  customMetadata?: Record<string, string>;
}

/** A queue message: the staged object's key, which is also its S3 key. */
export interface StagedDelivery {
  key: string;
}

/** The subset of a queue producer binding this Worker uses. */
export interface DeliveryQueue {
  send(body: StagedDelivery): Promise<void>;
  sendBatch(messages: Array<{ body: StagedDelivery }>): Promise<void>;
}

export interface QueueMessage {
  body: StagedDelivery;
  attempts: number;
  ack(): void;
  retry(options: { delaySeconds: number }): void;
}

/** What `status` reports about staged deliveries that are not in S3 yet. */
export interface BufferStatus {
  staged: number;
  /** True when there are more staged objects than the Worker counted. */
  more: boolean;
  oldestStagedAt: string | null;
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
  /** Null in direct mode. */
  buffer: BufferStatus | null;
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

// A copy holds two connections, the R2 read and the S3 write, and a Worker invocation gets six. With
// more copies at once, R2 reads take every connection and the S3 writes that would drain them wait forever.
const COPIES_AT_ONCE = 3;
// A copy that takes longer is aborted and retried, so a stalled connection cannot hold a consumer for its
// 15 minute limit. 11 MB takes 1 to 3 seconds.
const COPY_TIMEOUT_MS = 120_000;

// A failed copy to S3 waits 30 s, then twice as long each time, up to 1 hour. After 20 attempts
// (about 14 hours) the message goes to the dead letter queue; the staged object stays in R2.
const RETRY_BASE_SECONDS = 30;
const RETRY_MAX_SECONDS = 3600;

// Every minute, the sweep re-queues staged objects older than 15 minutes: their message was lost,
// dead-lettered, or is waiting out a long retry delay. It lists at most 10,000 staged objects per run.
const SWEEP_AFTER_MS = 15 * 60_000;
const SWEEP_PAGES = 10;

const LAST_DELIVERY_KEY = "last-delivery";
const LAST_ERROR_KEY = "last-error";

// KV allows about one write per second per key and bills per write, so each
// isolate records a delivery at most once a minute and an error at most every
// 10 seconds. Test deliveries are always recorded, so `setup` sees them at once.
const RECORD_INTERVAL_MS = { [LAST_DELIVERY_KEY]: 60_000, [LAST_ERROR_KEY]: 10_000 };
const lastRecordedAt = new Map<string, number>();

export default {
  async fetch(request: Request, env: Env, ctx: WorkerContext): Promise<Response> {
    if (!env.WEBHOOK_PATH_SECRET) {
      return reply(500, "Missing settings: WEBHOOK_PATH_SECRET");
    }
    const [, secret = "", action, ...rest] = new URL(request.url).pathname.split("/");
    if (!(await safeEqual(secret, env.WEBHOOK_PATH_SECRET)) || rest.length > 0) {
      // A delivery with the right webhook id at a wrong path comes from a webhook that still has
      // an old URL (for example after --rotate-path-secret). Record it, so `status` shows it.
      const webhookId = request.headers.get("x-inference-webhook-id");
      if (webhookId && env.INFERENCE_WEBHOOK_ID && (await safeEqual(webhookId, env.INFERENCE_WEBHOOK_ID))) {
        return fail(env, ctx, request, 404, "Wrong path: the webhook URL on inference.net is out of date");
      }
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

  /** Buffered mode: copies staged deliveries to S3. */
  async queue(batch: { messages: readonly QueueMessage[] }, env: Env): Promise<void> {
    const pending = [...batch.messages];
    const copyNext = async (): Promise<void> => {
      for (let message = pending.shift(); message; message = pending.shift()) {
        const { key } = message.body;
        const started = Date.now();
        const result = await deliverStaged(env, key);
        if (result.ok) {
          message.ack();
          log("log", { event: "delivered", key, result: result.message, attempts: message.attempts, ms: Date.now() - started });
          continue;
        }
        const delaySeconds = retryDelaySeconds(message.attempts);
        message.retry({ delaySeconds });
        log("warn", { event: "retry", key, attempts: message.attempts, delaySeconds, error: result.message });
      }
    };
    await Promise.all(Array.from({ length: COPIES_AT_ONCE }, copyNext));
  },

  /**
   * Buffered mode: re-queues staged objects older than 15 minutes, and logs the backlog. It first copies
   * one of them itself, and re-queues the rest only when that works, so an S3 outage does not pile up messages.
   */
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    if (!env.STAGING || !env.DELIVERIES) {
      return;
    }
    const queue = env.DELIVERIES;
    const scan = await scanStaging(env.STAGING, SWEEP_PAGES, Date.now() - SWEEP_AFTER_MS);
    const [first, ...rest] = scan.stale;
    const probe = first ? await deliverStaged(env, first) : null;
    if (probe?.ok) {
      const chunks = Array.from({ length: Math.ceil(rest.length / 100) }, (_, index) => rest.slice(index * 100, index * 100 + 100));
      await Promise.all(chunks.map((keys) => queue.sendBatch(keys.map((key) => ({ body: { key } })))));
    }
    log(probe && !probe.ok ? "warn" : "log", {
      event: "sweep",
      staged: scan.staged,
      more: scan.more,
      oldestStagedAt: scan.oldestStagedAt,
      stale: scan.stale.length,
      requeued: probe?.ok ? scan.stale.length : 0,
      ...(probe && !probe.ok ? { error: probe.message } : {}),
    });
  },
};

/** Rejects a delivery: logs it, records it as the last error, and answers with `status`. */
function fail(env: Env, ctx: WorkerContext, request: Request, status: number, message: string): Response {
  const event = request.headers.get("x-inference-event");
  console.warn(`Rejected ${event ?? "delivery"} with HTTP ${status}: ${message}`);
  record(env, ctx, LAST_ERROR_KEY, { at: new Date().toISOString(), event, status, message }, false);
  return reply(status, message);
}

async function handleDelivery(request: Request, env: Env, ctx: WorkerContext): Promise<Response> {
  const event = request.headers.get("x-inference-event");
  const missing = missingSettings(env);
  if (missing.length > 0) {
    return fail(env, ctx, request, 500, `Missing settings: ${missing.join(", ")}`);
  }
  const prefix = env.S3_KEY_PREFIX ?? "";
  if (!SAFE_KEY_PREFIX.test(prefix)) {
    return fail(env, ctx, request, 500, "S3_KEY_PREFIX may only contain A-Z a-z 0-9 / _ . -");
  }
  const webhookId = request.headers.get("x-inference-webhook-id") ?? "";
  if (!(await safeEqual(webhookId, env.INFERENCE_WEBHOOK_ID))) {
    return fail(env, ctx, request, 401, "X-Inference-Webhook-ID does not match INFERENCE_WEBHOOK_ID");
  }
  const key = objectKey(request.headers);
  if (!key) {
    return fail(env, ctx, request, 400, "Unsupported event or missing id header");
  }

  const body = await request.arrayBuffer();
  const marker = hasFailure(body) ? `${prefix}failures/${key}` : null;
  if (env.STAGING && env.DELIVERIES) {
    // The 200 below stops inference.net's retries, so answer it only after R2 and the queue both have the delivery.
    try {
      await env.STAGING.put(`${prefix}${key}`, body, { customMetadata: marker ? { marker } : {} });
      await env.DELIVERIES.send({ key: `${prefix}${key}` });
    } catch (error) {
      return fail(env, ctx, request, 503, `Could not stage the delivery: ${String(error)}`);
    }
    log("log", { event: "staged", key: `${prefix}${key}`, bytes: body.byteLength });
  } else {
    // Written before the result, so a saved result with a failed request always has its marker.
    if (marker) {
      const markerResult = await putObject(env, marker, "{}");
      if (!markerResult.ok) {
        return fail(env, ctx, request, 502, markerResult.message);
      }
    }
    const result = await putObject(env, `${prefix}${key}`, body);
    if (!result.ok) {
      return fail(env, ctx, request, 502, result.message);
    }
    console.log(`Saved ${event} to ${prefix}${key}`);
  }
  // Always record test deliveries (the dashboard's Test Webhook sends ids that start with "test-"), and
  // the first success after an error, so `status` does not keep showing an error that is fixed.
  const always =
    event === "webhook.test" ||
    key.includes("/test-") ||
    (lastRecordedAt.get(LAST_ERROR_KEY) ?? 0) >= (lastRecordedAt.get(LAST_DELIVERY_KEY) ?? 0);
  record(env, ctx, LAST_DELIVERY_KEY, { at: new Date().toISOString(), event: event ?? "", key: `${prefix}${key}` }, always);
  return reply(200, `${prefix}${key}`);
}

/** Required settings that are empty, plus the other half of the buffered-mode binding pair. */
function missingSettings(env: Env): string[] {
  const missing: string[] = REQUIRED_SETTINGS.filter((name) => !env[name]);
  if (env.STAGING && !env.DELIVERIES) missing.push("DELIVERIES");
  if (env.DELIVERIES && !env.STAGING) missing.push("STAGING");
  return missing;
}

async function workerStatus(env: Env, probe: boolean): Promise<WorkerStatus> {
  const missing = missingSettings(env);
  const prefix = env.S3_KEY_PREFIX ?? "";
  const canProbe =
    probe && SAFE_KEY_PREFIX.test(prefix) && !missing.some((name) => name.startsWith("S3_"));
  const probeKey = `${prefix}tests/status-probe.json`;
  const probeResult = canProbe
    ? await putObject(env, probeKey, JSON.stringify({ probe: true, at: new Date().toISOString() }))
    : null;
  const scan = env.STAGING ? await scanStaging(env.STAGING, SWEEP_PAGES, 0) : null;
  return {
    missingSettings: missing,
    bucket: env.S3_BUCKET || null,
    region: env.S3_REGION || null,
    keyPrefix: prefix,
    endpoint: env.S3_ENDPOINT || null,
    statusStore: Boolean(env.STATUS),
    lastDelivery: await readRecord<DeliveryRecord>(env, LAST_DELIVERY_KEY),
    lastError: await readRecord<ErrorRecord>(env, LAST_ERROR_KEY),
    probe: probeResult && { key: probeKey, ...probeResult },
    buffer: scan && { staged: scan.staged, more: scan.more, oldestStagedAt: scan.oldestStagedAt },
  };
}

/**
 * Copies one staged delivery to S3 (its failure marker first), then deletes it from R2. Never throws.
 * A missing object was already delivered, so it counts as success. S3 checks the body against the MD5
 * that R2 computed when the delivery was staged.
 */
export async function deliverStaged(env: Env, key: string): Promise<{ ok: boolean; message: string }> {
  const staging = env.STAGING;
  if (!staging) {
    return { ok: false, message: "STAGING is not bound" };
  }
  try {
    const staged = await staging.get(key);
    if (!staged) {
      return { ok: true, message: "already delivered" };
    }
    const marker = staged.customMetadata?.marker;
    const markerResult = marker ? await putObject(env, marker, "{}") : null;
    if (markerResult && !markerResult.ok) {
      await staged.body.cancel();
      return markerResult;
    }
    const md5 = staged.checksums.md5;
    const result = await putObject(env, key, staged.body, md5 ? { "Content-MD5": base64(md5) } : {});
    if (!result.ok) {
      return result;
    }
    // A delivery staged again under this key while this copy ran has its own queue message, so leave it.
    if ((await staging.head(key))?.etag === staged.etag) {
      await staging.delete(key);
    }
    return { ok: true, message: "OK" };
  } catch (error) {
    return { ok: false, message: String(error) };
  }
}

/** Lists up to `pages` pages of staged objects: how many, the oldest, and the keys staged before `staleBefore`. */
async function scanStaging(
  staging: StagingBucket,
  pages: number,
  staleBefore: number,
): Promise<BufferStatus & { stale: string[] }> {
  let staged = 0;
  let oldest: Date | null = null;
  const stale: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < pages; page++) {
    const listed = await staging.list({ limit: 1000, cursor });
    for (const { key, uploaded } of listed.objects) {
      staged++;
      if (!oldest || uploaded < oldest) oldest = uploaded;
      if (uploaded.getTime() < staleBefore) stale.push(key);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
    if (!cursor) break;
  }
  return { staged, more: cursor !== undefined, oldestStagedAt: oldest?.toISOString() ?? null, stale };
}

export function retryDelaySeconds(attempts: number): number {
  return Math.min(RETRY_BASE_SECONDS * 2 ** Math.max(attempts - 1, 0), RETRY_MAX_SECONDS);
}

/** PUTs one object. Never throws; the message says what S3 answered. */
async function putObject(
  env: Env,
  key: string,
  body: ArrayBuffer | string | ReadableStream,
  headers: Record<string, string> = {},
): Promise<{ ok: boolean; status: number; message: string }> {
  const s3 = new AwsClient({
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    service: "s3",
    region: env.S3_REGION,
    // A stream can be sent only once; the queue retries a failed copy instead.
    retries: body instanceof ReadableStream ? 0 : S3_RETRIES,
  });
  const signal = body instanceof ReadableStream ? AbortSignal.timeout(COPY_TIMEOUT_MS) : undefined;
  const url = objectUrl(env, key);
  try {
    const response = await s3.fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers },
      body,
      signal,
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

// A generation state other than "Success", or a group that failed as a whole. A quote inside a
// JSON string is escaped, so only real fields match. Another field named "state" can match too,
// which only costs a reader one extra GET.
const FAILURE = /"state"\s*:\s*"(?!Success")|"status"\s*:\s*"failed"/;

// hasFailure decodes 1 MB at a time, so a large delivery is not held twice in memory, once as bytes and
// once as text. Slices overlap by 1 KB, so a match is never cut in two.
const SCAN_SLICE = 1 << 20;
const SCAN_OVERLAP = 1 << 10;

/**
 * True when a delivery holds a request that did not succeed. The Worker then
 * also writes `failures/<key>`, so a reader finds those results by listing
 * keys. Scans the text instead of parsing it, which keeps CPU per delivery low.
 */
export function hasFailure(body: ArrayBuffer): boolean {
  const decoder = new TextDecoder();
  for (let start = 0; ; start += SCAN_SLICE - SCAN_OVERLAP) {
    const end = Math.min(start + SCAN_SLICE, body.byteLength);
    if (FAILURE.test(decoder.decode(new Uint8Array(body, start, end - start)))) return true;
    if (end === body.byteLength) return false;
  }
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

/** One JSON log line, which Workers Logs indexes by field. */
function log(level: "log" | "warn", fields: Record<string, unknown>): void {
  console[level](JSON.stringify(fields));
}

function base64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function reply(status: number, body: string): Response {
  return new Response(body, { status });
}
