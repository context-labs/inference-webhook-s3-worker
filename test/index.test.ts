import { afterEach, describe, expect, it, vi } from "vitest";

import worker, { type Env, objectKey } from "../src/index";

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
}: { path?: string; method?: string; headers?: Record<string, string> } = {}): Request {
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
    body: method === "POST" ? groupBody : undefined,
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

describe("S3 write", () => {
  it("PUTs the raw body to a virtual-hosted AWS URL and returns 200", async () => {
    const fetchMock = mockS3(new Response(null, { status: 200 }));
    const response = await worker.fetch(delivery(), env, ctx);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("embeddings/groups/grp_123.json");
    const sent = fetchMock.mock.calls[0]?.[0] as Request;
    expect(sent.method).toBe("PUT");
    expect(sent.url).toBe("https://results.s3.us-east-1.amazonaws.com/embeddings/groups/grp_123.json");
    expect(sent.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/s3\//);
    expect(await sent.text()).toBe(groupBody);
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
