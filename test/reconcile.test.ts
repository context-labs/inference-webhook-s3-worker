import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type Generation,
  groupPayload,
  listSource,
  logLineId,
  logSource,
  readCheckpoint,
  reconcile,
  type ReconcileOptions,
  scrubImageUrls,
  type SourceItem,
} from "../cli/reconcile";

const API = "https://api.example.test";
const BUCKET_HOST = "results.s3.us-east-1.amazonaws.com";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "reconcile-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function generation(id: string, state = "Success", finishedAt = "2026-11-20T05:38:15.208Z"): Generation {
  return {
    id,
    state,
    finishedAt,
    request: {
      input: [[{ role: "user", content: [{ type: "image_url", image_url: { url: "https://images.example/a.jpg" } }] }]],
      model: "google/siglip2-base-patch16-naflex",
    },
    response: state === "Success" ? { data: [{ embedding: [0.5], index: 0, object: "embedding" }] } : null,
  };
}

/** A bucket, the group API, and the group listing, answering by URL. Records every request. */
function fakeServices({
  objects = new Map<string, string>(),
  groups = {} as Record<string, Generation[]>,
  pages = [] as Array<{ data: unknown[]; has_more: boolean }>,
  flaky = 0,
} = {}) {
  const requests: Array<{ method: string; url: URL; headers: Headers }> = [];
  let failuresLeft = flaky;
  const fetchFn = (async (input: Request) => {
    const url = new URL(input.url);
    requests.push({ method: input.method, url, headers: input.headers });
    if (failuresLeft > 0) {
      failuresLeft--;
      return new Response("SlowDown", { status: 503 });
    }
    if (url.host === BUCKET_HOST) {
      const key = url.pathname.slice(1);
      if (input.method === "HEAD") return new Response(null, { status: objects.has(key) ? 200 : 404 });
      if (input.method === "PUT") {
        objects.set(key, await input.text());
        return new Response(null, { status: 200 });
      }
    }
    if (input.headers.get("authorization") !== "Bearer inf-key") return new Response("no", { status: 401 });
    const group = /^\/v1\/async\/group\/([^/]+)\/generations$/.exec(url.pathname)?.[1];
    if (group) {
      const generations = groups[group];
      return generations ? Response.json({ generations }) : new Response("not found", { status: 404 });
    }
    if (url.pathname === "/v1/async/groups") return Response.json(pages.shift());
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return { fetch: fetchFn, objects, requests };
}

function options(fetchFn: typeof fetch, extra: Partial<ReconcileOptions> = {}): ReconcileOptions & { lines: string[] } {
  const lines: string[] = [];
  return {
    fetch: fetchFn,
    apiUrl: API,
    apiKey: "inf-key",
    s3: { bucket: "results", region: "us-east-1", keyPrefix: "emb/", accessKeyId: "AKID", secretAccessKey: "secret" },
    concurrency: 8,
    repairConcurrency: 2,
    dryRun: false,
    log: (line) => lines.push(line),
    sleep: async () => {},
    lines,
    ...extra,
  };
}

async function* items(...ids: string[]): AsyncGenerator<SourceItem> {
  for (const [index, id] of ids.entries()) yield { group: { id }, position: String(index + 1) };
}

describe("reconcile", () => {
  it("writes each missing group with the webhook's body, and leaves present and running groups alone", async () => {
    const services = fakeServices({
      objects: new Map([["emb/groups/present.json", "{}"]]),
      groups: {
        missing: [generation("gv2_b", "Success", "2026-11-20T05:38:15.300Z"), generation("gv2_a")],
        running: [generation("gv2_c", "In Progress")],
        partial: [generation("gv2_d"), generation("gv2_e", "Failed")],
      },
    });
    const opts = options(services.fetch);

    const counts = await reconcile(opts, "test", items("present", "missing", "running", "partial", "../bad"));

    expect(counts).toEqual({ checked: 5, present: 1, missing: 2, repaired: 2, pending: 1, failed: 1 });
    const saved = JSON.parse(services.objects.get("emb/groups/missing.json")!);
    expect(saved).toEqual({
      event: "slow-group.completed",
      timestamp: "2026-11-20T05:38:15.300Z",
      groupId: "missing",
      data: {
        groupSize: 2,
        status: "completed",
        generations: [
          { ...generation("gv2_b", "Success", "2026-11-20T05:38:15.300Z"), request: { ...generation("x").request as object, input: [[{ role: "user", content: [{ type: "image_url", image_url: { url: "REDACTED" } }] }]] } },
          { ...generation("gv2_a"), request: { ...generation("x").request as object, input: [[{ role: "user", content: [{ type: "image_url", image_url: { url: "REDACTED" } }] }]] } },
        ],
      },
    });
    // Same field order as the webhook, so the bytes match apart from the timestamp.
    expect(Object.keys(saved)).toEqual(["event", "timestamp", "groupId", "data"]);
    expect(services.objects.has("emb/failures/groups/missing.json")).toBe(false);
    expect(services.objects.get("emb/failures/groups/partial.json")).toBe("{}");
    expect(services.objects.has("emb/groups/running.json")).toBe(false);
    const put = services.requests.find((r) => r.method === "PUT" && r.url.pathname === "/emb/groups/missing.json")!;
    expect(put.headers.get("x-amz-meta-reconciled")).toBe("true");
    expect(opts.lines).toContain('FAILED "../bad": not a group id');
  });

  it("writes nothing with dryRun", async () => {
    const services = fakeServices({ groups: { missing: [generation("gv2_a")] } });
    const counts = await reconcile(options(services.fetch, { dryRun: true }), "test", items("missing"));
    expect(counts).toMatchObject({ checked: 1, missing: 1, repaired: 0 });
    expect(services.requests.map((r) => r.method)).toEqual(["HEAD"]);
  });

  it("retries 503 answers", async () => {
    const services = fakeServices({ flaky: 2, groups: { missing: [generation("gv2_a")] } });
    const counts = await reconcile(options(services.fetch), "test", items("missing"));
    expect(counts).toMatchObject({ missing: 1, repaired: 1, failed: 0 });
  });

  it("counts a group the API does not know as failed", async () => {
    const services = fakeServices();
    const opts = options(services.fetch);
    const counts = await reconcile(opts, "test", items("unknown"));
    expect(counts).toMatchObject({ missing: 1, repaired: 0, failed: 1 });
    expect(opts.lines.some((line) => line.startsWith("FAILED unknown: GET group answered 404"))).toBe(true);
  });

  it("saves a checkpoint after each chunk, resumes from it, and deletes it when done", async () => {
    const log = join(dir, "submitted.jsonl");
    const ids = Array.from({ length: 250 }, (_, index) => `g${index}`);
    await writeFile(log, ids.map((groupId) => JSON.stringify({ groupId, custom_ids: ["a"] })).join("\n"));
    const services = fakeServices({ objects: new Map(ids.map((id) => [`emb/groups/${id}.json`, "{}"])) });
    const checkpoint = join(dir, "checkpoint.json");
    let stop = 150;
    const interrupted = async function* () {
      for await (const item of logSource(log, 0)) {
        if (stop-- === 0) throw new Error("interrupted");
        yield item;
      }
    };
    await expect(reconcile(options(services.fetch, { checkpoint, concurrency: 1 }), "log", interrupted())).rejects.toThrow("interrupted");
    const saved = await readCheckpoint(checkpoint, "log");
    expect(saved).toMatchObject({ position: "100", counts: { checked: 100, present: 100 } });
    expect(await readCheckpoint(checkpoint, "another source")).toBeNull();

    const heads = services.requests.length;
    const counts = await reconcile(options(services.fetch, { checkpoint, concurrency: 1 }), "log", logSource(log, 100), saved!.counts);
    expect(counts).toMatchObject({ checked: 250, present: 250 });
    expect(services.requests.length - heads).toBe(150);
    await expect(readFile(checkpoint)).rejects.toThrow();
  });
});

describe("logLineId", () => {
  it("reads bare ids and JSON lines, and gives an empty id for an unreadable line", () => {
    expect(logLineId("abc_123")).toBe("abc_123");
    expect(logLineId('{"groupId":"abc","custom_ids":[]}')).toBe("abc");
    expect(logLineId('{"groupId":"ab')).toBe("");
    expect(logLineId('{"other":1}')).toBe("");
  });
});

describe("listSource", () => {
  it("pages with after, sends since and until as Unix seconds, and passes status and completed_at on", async () => {
    const services = fakeServices({
      pages: [
        { data: [{ id: "g1", status: "completed", created_at: 1795000000, completed_at: 1795000100 }], has_more: true },
        { data: [{ id: "g2", status: "in_progress", created_at: 1795000001, completed_at: null }], has_more: false },
      ],
    });
    const result: SourceItem[] = [];
    const since = new Date("2026-11-01T00:00:00Z");
    const until = new Date("2026-11-02T00:00:00Z");
    for await (const item of listSource(options(services.fetch), since, until, "g0")) result.push(item);

    expect(result).toEqual([
      { group: { id: "g1", status: "completed", completedAt: new Date(1795000100 * 1000).toISOString() }, position: "g1" },
      { group: { id: "g2", status: "in_progress", completedAt: undefined }, position: "g2" },
    ]);
    const queries = services.requests.map((r) => Object.fromEntries(r.url.searchParams));
    expect(queries).toEqual([
      { limit: "100", since: "1793491200", until: "1793577600", after: "g0" },
      { limit: "100", since: "1793491200", until: "1793577600", after: "g1" },
    ]);
  });

  it("skips running groups without a HEAD, and saves failed groups with status failed", async () => {
    const services = fakeServices({
      groups: { g2: [generation("gv2_a", "Failed")] },
      pages: [
        {
          data: [
            { id: "g1", status: "in_progress", created_at: 1, completed_at: null },
            { id: "g2", status: "expired", created_at: 2, completed_at: null },
          ],
          has_more: false,
        },
      ],
    });
    const opts = options(services.fetch);
    const counts = await reconcile(opts, "list", listSource(opts, new Date(0), new Date(), undefined));
    expect(counts).toMatchObject({ checked: 2, pending: 1, missing: 1, repaired: 1 });
    expect(services.requests.filter((r) => r.url.pathname.endsWith("/g1.json"))).toEqual([]);
    expect(JSON.parse(services.objects.get("emb/groups/g2.json")!).data.status).toBe("failed");
  });

  it("says to use --from-log when the API has no listing", async () => {
    const fetchFn = (async () => new Response("Not Found", { status: 404 })) as unknown as typeof fetch;
    const run = async () => {
      for await (const _ of listSource(options(fetchFn), new Date(0), new Date(), undefined));
    };
    await expect(run()).rejects.toThrow("use --from-log");
  });
});

describe("groupPayload and scrubImageUrls", () => {
  it("takes the timestamp from the listing when it has one", () => {
    const payload = groupPayload({ id: "g", status: "completed", completedAt: "2026-11-20T06:00:00.000Z" }, [generation("a")]);
    expect(payload).toMatchObject({ timestamp: "2026-11-20T06:00:00.000Z", data: { groupSize: 1, status: "completed" } });
  });

  it("redacts a single-image input, a batch, and chat image parts, and keeps text", () => {
    const image = { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] };
    const redacted = [{ role: "user", content: [{ type: "image_url", image_url: { url: "REDACTED" } }] }];
    expect(scrubImageUrls({ input: [image], model: "m" })).toEqual({ input: redacted, model: "m" });
    expect(scrubImageUrls({ input: [[image], [image]], model: "m" })).toEqual({ input: [redacted, redacted], model: "m" });
    expect(scrubImageUrls({ input: ["text", "more"] })).toEqual({ input: ["text", "more"] });
    expect(
      scrubImageUrls({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "https://x", detail: "low" } }] }] }),
    ).toEqual({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "REDACTED" } }] }] });
  });
});
