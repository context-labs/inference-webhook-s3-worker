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
    const response = await worker.fetch(delivery({ path: "/wrong" }), env);
    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 401 for a wrong or missing webhook id and does not call S3", async () => {
    const fetchMock = mockS3();
    const wrong = await worker.fetch(delivery({ headers: { "X-Inference-Webhook-ID": "other" } }), env);
    const request = delivery();
    request.headers.delete("X-Inference-Webhook-ID");
    const missing = await worker.fetch(request, env);
    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 405 for a method other than POST", async () => {
    const response = await worker.fetch(delivery({ method: "GET" }), env);
    expect(response.status).toBe(405);
  });

  it("returns 500 and names each missing setting", async () => {
    const response = await worker.fetch(delivery(), { ...env, S3_BUCKET: "", INFERENCE_WEBHOOK_ID: "" });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Missing settings: INFERENCE_WEBHOOK_ID, S3_BUCKET");
  });

  it("returns 500 for a key prefix that needs URL encoding", async () => {
    const response = await worker.fetch(delivery(), { ...env, S3_KEY_PREFIX: "a b/" });
    expect(response.status).toBe(500);
  });

  it("returns 400 for an unknown event", async () => {
    const response = await worker.fetch(delivery({ headers: { "X-Inference-Event": "something.new" } }), env);
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
    const response = await worker.fetch(delivery(), env);

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
    await worker.fetch(delivery(), { ...env, S3_ENDPOINT: "http://localhost:9000/", S3_KEY_PREFIX: undefined });
    const sent = fetchMock.mock.calls[0]?.[0] as Request;
    expect(sent.url).toBe("http://localhost:9000/results/groups/grp_123.json");
  });

  it("returns 502 when S3 rejects the write", async () => {
    mockS3(new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 }));
    const response = await worker.fetch(delivery(), env);
    expect(response.status).toBe(502);
  });

  it("retries an S3 5xx, then returns 502", async () => {
    const fetchMock = mockS3(...Array.from({ length: 4 }, () => new Response(null, { status: 503 })));
    const response = await worker.fetch(delivery(), env);
    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("returns 502 when S3 is unreachable", async () => {
    mockS3(new TypeError("fetch failed"));
    const response = await worker.fetch(delivery(), env);
    expect(response.status).toBe(502);
  });
});
