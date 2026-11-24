import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import worker, { type Env, hasFailure, objectKey, retryDelaySeconds } from "../src/index";

const env: Env = {
  WEBHOOK_PATH_SECRET: "path-secret",
  INFERENCE_WEBHOOK_ID: "AhALzdz8S",
  S3_BUCKET: "results",
  S3_REGION: "us-east-1",
  S3_ACCESS_KEY_ID: "AKIDEXAMPLE",
  S3_SECRET_ACCESS_KEY: "secret",
  S3_KEY_PREFIX: "embeddings/",
};

const ctx = { waitUntil: () => {} };

const groupBody = JSON.stringify({
  event: "slow-group.completed",
  timestamp: "2026-01-01T00:00:00.000Z",
  groupId: "grp_123",
  data: { groupSize: 1, status: "completed", generations: [] },
});

function delivery({
  path = "/path-secret",
  method = "POST",
  headers = {},
  body = groupBody,
}: { path?: string; method?: string; headers?: Record<string, string>; body?: string } = {}): Request {
  return new Request(`https://worker.example.com${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Inference-Event": "slow-group.completed",
      "X-Inference-Webhook-ID": "AhALzdz8S",
      "X-Inference-Group-ID": "grp_123",
      "X-Inference-Delivery-Attempt": "1",
      ...headers,
    },
    body: method === "POST" ? body : undefined,
  });
}

function mockS3(...responses: Array<Response | Error>) {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  for (const response of responses) {
    if (response instanceof Error) {
      fetchMock.mockRejectedValueOnce(response);
    } else {
      fetchMock.mockResolvedValueOnce(response);
    }
  }
  return fetchMock;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("request checks", () => {
  it("returns 404 for a wrong path and does not call S3", async () => {
    const fetchMock = mockS3();
    const response = await worker.fetch(delivery({ path: "/wrong" }), env, ctx);
    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 401 for a wrong or missing webhook id and does not call S3", async () => {
    const fetchMock = mockS3();
    const wrong = await worker.fetch(delivery({ headers: { "X-Inference-Webhook-ID": "other" } }), env, ctx);
    const request = delivery();
    request.headers.delete("X-Inference-Webhook-ID");
    const missing = await worker.fetch(request, env, ctx);
    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 405 for a method other than POST", async () => {
    const response = await worker.fetch(delivery({ method: "GET" }), env, ctx);
    expect(response.status).toBe(405);
  });

  it("returns 500 and names each missing setting", async () => {
    const response = await worker.fetch(delivery(), { ...env, S3_BUCKET: "", INFERENCE_WEBHOOK_ID: "" }, ctx);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Missing settings: INFERENCE_WEBHOOK_ID, S3_BUCKET");
  });

  it("returns 500 for a key prefix that needs URL encoding", async () => {
    const response = await worker.fetch(delivery(), { ...env, S3_KEY_PREFIX: "a b/" }, ctx);
    expect(response.status).toBe(500);
  });

  it("returns 400 for an unknown event", async () => {
    const response = await worker.fetch(delivery({ headers: { "X-Inference-Event": "something.new" } }), env, ctx);
    expect(response.status).toBe(400);
  });
});

describe("objectKey", () => {
  it.each([
    [{ "x-inference-event": "slow-group.completed", "x-inference-group-id": "grp_1" }, "groups/grp_1.json"],
    [{ "x-inference-event": "generation.completed", "x-inference-generation-id": "gen-1" }, "generations/gen-1.json"],
    [
      {
        "x-inference-event": "async-embedding.completed",
        "x-inference-generation-id": "emb_1",
        "x-inference-embedding-id": "emb_1",
      },
      "generations/emb_1.json",
    ],
    [{ "x-inference-event": "webhook.test" }, "tests/webhook-test.json"],
    [{ "x-inference-event": "slow-group.completed" }, null],
    [{ "x-inference-event": "slow-group.completed", "x-inference-group-id": "../x" }, null],
    [{ "x-inference-event": "unknown", "x-inference-generation-id": "gen-1" }, null],
  ])("%o -> %s", (headers, expected) => {
    expect(objectKey(new Headers(headers))).toBe(expected);
  });
});

describe("hasFailure", () => {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer;
  const generation = (state: string, metadata: Record<string, unknown> = {}) => ({ id: "gen_1", state, request: { metadata } });
  const group = (status: string, ...generations: unknown[]) => ({ event: "slow-group.completed", data: { status, generations } });

  it.each([
    ["every request succeeded", group("completed", generation("Success"), generation("Success")), false],
    ["a request failed", group("completed", generation("Success"), generation("Failed")), true],
    ["a request was cancelled", group("completed", generation("Cancelled")), true],
    ["the group failed with no generations", group("failed"), true],
    ["a failed generation event", { event: "async-embedding.completed", data: generation("Failed") }, true],
    ["a successful generation event", { event: "async-embedding.completed", data: generation("Success") }, false],
    ["the words inside a string value", group("completed", generation("Success", { note: '"state":"Failed"' })), false],
  ])("%s -> %s", (_, payload, expected) => {
    expect(hasFailure(encode(payload))).toBe(expected);
  });

  it("allows whitespace around the colon", () => {
    const text = new TextEncoder().encode(JSON.stringify(group("completed", generation("Failed")), null, 2)).buffer;
    expect(hasFailure(text)).toBe(true);
  });
});

describe("S3 write", () => {
  it("PUTs the raw body to a virtual-hosted AWS URL and returns 200", async () => {
    const fetchMock = mockS3(new Response(null, { status: 200 }));
    const response = await worker.fetch(delivery(), env, ctx);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe("embeddings/groups/grp_123.json");
    const sent = fetchMock.mock.calls[0]?.[0] as Request;
    expect(sent.method).toBe("PUT");
    expect(sent.url).toBe("https://results.s3.us-east-1.amazonaws.com/embeddings/groups/grp_123.json");
    expect(sent.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/s3\//);
    expect(await sent.text()).toBe(groupBody);
  });

  it("writes failures/<key> before the result when a request failed", async () => {
    const body = JSON.stringify({
      event: "slow-group.completed",
      groupId: "grp_123",
      data: { groupSize: 2, status: "completed", generations: [{ id: "gen_1", state: "Success" }, { id: "gen_2", state: "Failed" }] },
    });
    const fetchMock = mockS3(new Response(null, { status: 200 }), new Response(null, { status: 200 }));
    const response = await worker.fetch(delivery({ body }), env, ctx);

    expect(response.status).toBe(200);
    const [marker, result] = fetchMock.mock.calls.map(([request]) => request as Request);
    expect(marker?.url).toBe("https://results.s3.us-east-1.amazonaws.com/embeddings/failures/groups/grp_123.json");
    expect(result?.url).toBe("https://results.s3.us-east-1.amazonaws.com/embeddings/groups/grp_123.json");
    expect(await result?.text()).toBe(body);
  });

  it("returns 502 and skips the result when the marker write fails", async () => {
    const body = JSON.stringify({ event: "slow-group.completed", groupId: "grp_123", data: { status: "failed", generations: [] } });
    const fetchMock = mockS3(new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 }));
    const response = await worker.fetch(delivery({ body }), env, ctx);

    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses a path-style URL on a custom endpoint", async () => {
    const fetchMock = mockS3(new Response(null, { status: 200 }));
    await worker.fetch(delivery(), { ...env, S3_ENDPOINT: "http://localhost:9000/", S3_KEY_PREFIX: undefined }, ctx);
    const sent = fetchMock.mock.calls[0]?.[0] as Request;
    expect(sent.url).toBe("http://localhost:9000/results/groups/grp_123.json");
  });

  it("returns 502 when S3 rejects the write", async () => {
    mockS3(new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 }));
    const response = await worker.fetch(delivery(), env, ctx);
    expect(response.status).toBe(502);
  });

  it("retries an S3 5xx, then returns 502", async () => {
    const fetchMock = mockS3(...Array.from({ length: 4 }, () => new Response(null, { status: 503 })));
    const response = await worker.fetch(delivery(), env, ctx);
    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("returns 502 when S3 is unreachable", async () => {
    mockS3(new TypeError("fetch failed"));
    const response = await worker.fetch(delivery(), env, ctx);
    expect(response.status).toBe(502);
  });
});

describe("status route", () => {
  function kv(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return {
      data,
      get: async (key: string) => data.get(key) ?? null,
      put: async (key: string, value: string) => {
        data.set(key, value);
      },
    };
  }

  it("reports missing settings and recorded deliveries without touching S3", async () => {
    const fetchMock = mockS3();
    const store = kv({ "last-delivery": JSON.stringify({ at: "2026-01-01T00:00:00.000Z", event: "webhook.test", key: "k" }) });
    const response = await worker.fetch(
      new Request("https://worker.example.com/path-secret/status"),
      { ...env, INFERENCE_WEBHOOK_ID: "", STATUS: store },
      ctx,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      missingSettings: ["INFERENCE_WEBHOOK_ID"],
      bucket: "results",
      statusStore: true,
      lastDelivery: { event: "webhook.test" },
      lastError: null,
      probe: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes a probe object with ?probe=1", async () => {
    const fetchMock = mockS3(new Response(null, { status: 200 }));
    const response = await worker.fetch(new Request("https://worker.example.com/path-secret/status?probe=1"), env, ctx);
    expect(await response.json()).toMatchObject({ probe: { ok: true, key: "embeddings/tests/status-probe.json" } });
    expect((fetchMock.mock.calls[0]?.[0] as Request).url).toBe(
      "https://results.s3.us-east-1.amazonaws.com/embeddings/tests/status-probe.json",
    );
  });

  it("returns 404 for the status route under a wrong path secret", async () => {
    const response = await worker.fetch(new Request("https://worker.example.com/wrong/status"), env, ctx);
    expect(response.status).toBe(404);
  });

  it("records the last delivery and the last error in KV", async () => {
    vi.resetModules();
    const { default: freshWorker } = await import("../src/index");
    const store = kv();
    const pending: Promise<unknown>[] = [];
    const recordingCtx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) };

    mockS3(new Response(null, { status: 200 }));
    await freshWorker.fetch(delivery({ headers: { "X-Inference-Event": "webhook.test" } }), { ...env, STATUS: store }, recordingCtx);
    await freshWorker.fetch(delivery({ headers: { "X-Inference-Webhook-ID": "other" } }), { ...env, STATUS: store }, recordingCtx);
    await Promise.all(pending);

    expect(JSON.parse(store.data.get("last-delivery") ?? "null")).toMatchObject({
      event: "webhook.test",
      key: "embeddings/tests/webhook-test.json",
    });
    expect(JSON.parse(store.data.get("last-error") ?? "null")).toMatchObject({ status: 401 });
  });

  it("always records dashboard test events, which carry ids that start with test-", async () => {
    vi.resetModules();
    const { default: freshWorker } = await import("../src/index");
    const store = kv();
    const pending: Promise<unknown>[] = [];
    const recordingCtx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) };

    mockS3(new Response(null, { status: 200 }), new Response(null, { status: 200 }));
    await freshWorker.fetch(delivery(), { ...env, STATUS: store }, recordingCtx);
    await freshWorker.fetch(
      delivery({ headers: { "X-Inference-Group-ID": "test-group-1795132156487" } }),
      { ...env, STATUS: store },
      recordingCtx,
    );
    await Promise.all(pending);

    expect(JSON.parse(store.data.get("last-delivery") ?? "null")).toMatchObject({
      event: "slow-group.completed",
      key: "embeddings/groups/test-group-1795132156487.json",
    });
  });

  it("records the first success after an error, even inside the once-a-minute window", async () => {
    vi.resetModules();
    const { default: freshWorker } = await import("../src/index");
    const store = kv();
    const pending: Promise<unknown>[] = [];
    const recordingCtx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) };

    mockS3(new Response(null, { status: 200 }), new Response(null, { status: 200 }));
    await freshWorker.fetch(delivery(), { ...env, STATUS: store }, recordingCtx);
    await freshWorker.fetch(delivery({ headers: { "X-Inference-Webhook-ID": "other" } }), { ...env, STATUS: store }, recordingCtx);
    await freshWorker.fetch(delivery({ headers: { "X-Inference-Group-ID": "grp_456" } }), { ...env, STATUS: store }, recordingCtx);
    await Promise.all(pending);

    expect(JSON.parse(store.data.get("last-delivery") ?? "null")).toMatchObject({ key: "embeddings/groups/grp_456.json" });
  });

  it("records a delivery to an old webhook URL, but not other wrong paths", async () => {
    const store = kv();
    const pending: Promise<unknown>[] = [];
    const recordingCtx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) };

    const stranger = delivery({ path: "/old-secret", headers: { "X-Inference-Webhook-ID": "other" } });
    expect((await worker.fetch(stranger, { ...env, STATUS: store }, recordingCtx)).status).toBe(404);
    expect(store.data.has("last-error")).toBe(false);

    const oldUrl = await worker.fetch(delivery({ path: "/old-secret" }), { ...env, STATUS: store }, recordingCtx);
    await Promise.all(pending);
    expect(oldUrl.status).toBe(404);
    expect(JSON.parse(store.data.get("last-error") ?? "null")).toMatchObject({ status: 404, event: "slow-group.completed" });
  });
});

describe("buffered mode", () => {
  function r2() {
    const objects = new Map<string, { bytes: Uint8Array<ArrayBuffer>; uploaded: Date; etag: string; customMetadata: Record<string, string> }>();
    let version = 0;
    const bucket = {
      objects,
      put: vi.fn(async (key: string, value: ArrayBuffer, options: { customMetadata: Record<string, string> }) => {
        objects.set(key, { bytes: new Uint8Array(value), uploaded: new Date(), etag: `etag-${++version}`, ...options });
      }),
      get: vi.fn(async (key: string) => {
        const object = objects.get(key);
        if (!object) return null;
        const md5 = createHash("md5").update(object.bytes).digest();
        return {
          etag: object.etag,
          body: new Response(object.bytes).body as ReadableStream,
          checksums: { md5: md5.buffer.slice(md5.byteOffset, md5.byteOffset + md5.byteLength) },
          customMetadata: object.customMetadata,
        };
      }),
      head: vi.fn(async (key: string) => objects.get(key) ?? null),
      delete: vi.fn(async (key: string) => {
        objects.delete(key);
      }),
      list: vi.fn(async ({ limit, cursor }: { limit: number; cursor?: string }) => {
        const keys = [...objects.keys()].sort();
        const start = cursor ? Number(cursor) : 0;
        const page = keys.slice(start, start + limit);
        const truncated = start + limit < keys.length;
        return {
          objects: page.map((key) => ({ key, uploaded: objects.get(key)!.uploaded })),
          truncated,
          cursor: truncated ? String(start + limit) : undefined,
        };
      }),
    };
    return bucket;
  }

  function queue() {
    return { send: vi.fn(async () => {}), sendBatch: vi.fn(async () => {}) };
  }

  function message(key: string, attempts = 1) {
    return { body: { key }, attempts, ack: vi.fn(), retry: vi.fn() };
  }

  function buffered() {
    const staging = r2();
    const deliveries = queue();
    return { staging, deliveries, env: { ...env, STAGING: staging, DELIVERIES: deliveries } };
  }

  it("stages the body under the final key, queues it, and returns 200 without calling S3", async () => {
    const fetchMock = mockS3();
    const { staging, deliveries, env: bufferedEnv } = buffered();
    const response = await worker.fetch(delivery(), bufferedEnv, ctx);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("embeddings/groups/grp_123.json");
    expect(new TextDecoder().decode(staging.objects.get("embeddings/groups/grp_123.json")?.bytes)).toBe(groupBody);
    expect(staging.objects.get("embeddings/groups/grp_123.json")?.customMetadata).toEqual({});
    expect(deliveries.send).toHaveBeenCalledWith({ key: "embeddings/groups/grp_123.json" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records the failure marker key on a staged delivery with a failed request", async () => {
    const { staging, env: bufferedEnv } = buffered();
    const body = JSON.stringify({ event: "slow-group.completed", data: { status: "failed", generations: [] } });
    await worker.fetch(delivery({ body }), bufferedEnv, ctx);
    expect(staging.objects.get("embeddings/groups/grp_123.json")?.customMetadata).toEqual({
      marker: "embeddings/failures/groups/grp_123.json",
    });
  });

  it.each(["put", "send"] as const)("returns 503 when the R2 %s fails, so inference.net retries", async (step) => {
    const { staging, deliveries, env: bufferedEnv } = buffered();
    (step === "put" ? staging.put : deliveries.send).mockRejectedValueOnce(new Error("unavailable"));
    const response = await worker.fetch(delivery(), bufferedEnv, ctx);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("unavailable");
  });

  it("returns 500 when only one of the two bindings is present", async () => {
    const response = await worker.fetch(delivery(), { ...env, STAGING: r2() }, ctx);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Missing settings: DELIVERIES");
  });

  it("consumer: writes the marker, then the body with its MD5, deletes the staged copy, and acks", async () => {
    const { staging, env: bufferedEnv } = buffered();
    const body = JSON.stringify({ event: "slow-group.completed", data: { status: "failed", generations: [] } });
    await worker.fetch(delivery({ body }), bufferedEnv, ctx);
    const fetchMock = mockS3(new Response(null, { status: 200 }), new Response(null, { status: 200 }));
    const msg = message("embeddings/groups/grp_123.json");

    await worker.queue({ messages: [msg] }, bufferedEnv);

    const [marker, result] = fetchMock.mock.calls.map(([request]) => request as Request);
    expect(marker?.url).toBe("https://results.s3.us-east-1.amazonaws.com/embeddings/failures/groups/grp_123.json");
    expect(result?.url).toBe("https://results.s3.us-east-1.amazonaws.com/embeddings/groups/grp_123.json");
    expect(result?.headers.get("content-md5")).toBe(createHash("md5").update(body).digest("base64"));
    expect(await result?.text()).toBe(body);
    expect(staging.objects.size).toBe(0);
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it("consumer: keeps the staged copy and retries with backoff when S3 fails", async () => {
    const { staging, env: bufferedEnv } = buffered();
    await worker.fetch(delivery(), bufferedEnv, ctx);
    const fetchMock = mockS3(new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 }));
    const msg = message("embeddings/groups/grp_123.json", 3);

    await worker.queue({ messages: [msg] }, bufferedEnv);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(staging.objects.size).toBe(1);
    expect(msg.ack).not.toHaveBeenCalled();
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
  });

  it("consumer: acks a message whose object was already delivered, without calling S3", async () => {
    const fetchMock = mockS3();
    const { env: bufferedEnv } = buffered();
    const msg = message("embeddings/groups/gone.json");
    await worker.queue({ messages: [msg] }, bufferedEnv);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalled();
  });

  it("consumer: keeps a delivery that was staged again while the copy ran", async () => {
    const { staging, env: bufferedEnv } = buffered();
    await worker.fetch(delivery(), bufferedEnv, ctx);
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
      await worker.fetch(delivery(), bufferedEnv, ctx);
      return new Response(null, { status: 200 });
    });
    await worker.queue({ messages: [message("embeddings/groups/grp_123.json")] }, bufferedEnv);
    expect(staging.objects.get("embeddings/groups/grp_123.json")?.etag).toBe("etag-2");
  });

  it("sweep: copies one stale object itself, then re-queues the other stale ones", async () => {
    const { staging, deliveries, env: bufferedEnv } = buffered();
    const old = new Date(Date.now() - 20 * 60_000);
    for (const id of ["a", "b", "c"]) await worker.fetch(delivery({ headers: { "X-Inference-Group-ID": id } }), bufferedEnv, ctx);
    staging.objects.get("embeddings/groups/a.json")!.uploaded = old;
    staging.objects.get("embeddings/groups/b.json")!.uploaded = old;
    mockS3(new Response(null, { status: 200 }));

    await worker.scheduled({}, bufferedEnv);

    expect([...staging.objects.keys()]).toEqual(["embeddings/groups/b.json", "embeddings/groups/c.json"]);
    expect(deliveries.sendBatch).toHaveBeenCalledWith([{ body: { key: "embeddings/groups/b.json" } }]);
  });

  it("sweep: re-queues nothing while S3 still fails", async () => {
    const { staging, deliveries, env: bufferedEnv } = buffered();
    await worker.fetch(delivery(), bufferedEnv, ctx);
    staging.objects.get("embeddings/groups/grp_123.json")!.uploaded = new Date(0);
    mockS3(new Response(null, { status: 403 }));

    await worker.scheduled({}, bufferedEnv);

    expect(staging.objects.size).toBe(1);
    expect(deliveries.sendBatch).not.toHaveBeenCalled();
  });

  it("status reports the staged count and the oldest staged object", async () => {
    const { staging, env: bufferedEnv } = buffered();
    await worker.fetch(delivery(), bufferedEnv, ctx);
    staging.objects.get("embeddings/groups/grp_123.json")!.uploaded = new Date("2026-01-01T00:00:00.000Z");
    const response = await worker.fetch(new Request("https://worker.example.com/path-secret/status"), bufferedEnv, ctx);
    expect((await response.json()).buffer).toEqual({ staged: 1, more: false, oldestStagedAt: "2026-01-01T00:00:00.000Z" });
  });

  it("retry delay doubles from 30 seconds up to 1 hour", () => {
    expect([1, 2, 3, 7, 8, 20].map(retryDelaySeconds)).toEqual([30, 60, 120, 1920, 3600, 3600]);
  });
});
