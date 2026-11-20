/**
 * Submit images to inference.net async image embeddings, in groups.
 * Same behavior as python/submit.py: 10 requests x 50 images per group, bounded
 * concurrency, a target images/s, retries, and a JSONL log for resume.
 * Each accepted group is printed as one JSON line and appended to the log.
 *
 * Usage (Node.js 22.18+, no dependencies; runs the .ts file directly):
 *   export INFERENCE_API_KEY=... INFERENCE_WEBHOOK_ID=... INFERENCE_MODEL=...
 *   node examples/submit-embeddings.ts ./images              # every .jpg/.jpeg/.png/.webp under a folder; id = relative path
 *   node examples/submit-embeddings.ts manifest.csv          # CSV with header "id,path" (no quoted fields)
 *   RATE=2000 CONCURRENCY=16 LOG=submitted.jsonl node examples/submit-embeddings.ts manifest.csv
 *
 * Exit code 1 if any group or image failed; rerun the same command to retry only those.
 */
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const API_URL = `${process.env.INFERENCE_API_URL ?? "https://api.inference.net"}/v1/async/group/embeddings`;
// inference.net gives you the model id for your account.
const MODEL = process.env.INFERENCE_MODEL ?? "your-embedding-model-id";
const MAX_DATA_URI_CHARS = 512 * 1024; // per image; larger images are rejected by the API
const MAX_ATTEMPTS = 8;
const MIME: Record<string, string> = { ".jpg": "jpeg", ".jpeg": "jpeg", ".png": "png", ".webp": "webp", ".gif": "gif" };

const source = process.argv[2];
const apiKey = process.env.INFERENCE_API_KEY;
const webhookId = process.env.INFERENCE_WEBHOOK_ID;
if (!source || !apiKey || !webhookId) {
  console.error("Usage: INFERENCE_API_KEY=... INFERENCE_WEBHOOK_ID=... node examples/submit-embeddings.ts <folder|manifest.csv>");
  process.exit(2);
}
const LOG = process.env.LOG ?? "submitted.jsonl";
const RATE = Number(process.env.RATE ?? 1000); // target images/s
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 8); // groups in flight
const IMAGES_PER_REQUEST = Number(process.env.IMAGES_PER_REQUEST ?? 50); // 1-50
const REQUESTS_PER_GROUP = Number(process.env.REQUESTS_PER_GROUP ?? 10); // 1-50

type Item = { id: string; path: string };

function listImages(src: string): Item[] {
  if (src.endsWith(".csv")) {
    const [header, ...rows] = readFileSync(src, "utf8").trim().split("\n");
    if (header?.trim() !== "id,path") throw new Error(`${src}: expected header "id,path"`);
    return rows.map((row) => {
      const comma = row.indexOf(",");
      return { id: row.slice(0, comma), path: row.slice(comma + 1).trim() };
    });
  }
  return readdirSync(src, { recursive: true, encoding: "utf8" })
    .filter((file) => extname(file).toLowerCase() in MIME)
    .sort()
    .map((file) => ({ id: file, path: join(src, file) }));
}

/** S3 HOOK: replace or extend this to read from your own storage (e.g. @aws-sdk/client-s3 GetObject for s3:// paths). */
async function readImage(path: string): Promise<Buffer> {
  if (path.startsWith("s3://")) throw new Error("s3:// paths need an S3 client: edit readImage()");
  return readFile(path);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST one group; retry 429/5xx/network errors with backoff + jitter. Returns groupId.
 * Not idempotent: if a POST times out after the server accepted it, the retry
 * creates a second group with the same images. Key results by custom_id.
 */
async function postGroup(body: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    let error: string;
    let retryAfter: string | null = null;
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": "embeddings-submit/1.0", // some default user agents (e.g. Python urllib) get 403
        },
        body,
        signal: AbortSignal.timeout(120_000),
      });
      if (response.ok) return ((await response.json()) as { groupId: string }).groupId;
      const detail = (await response.text()).slice(0, 500);
      if (response.status !== 429 && response.status < 500) {
        throw new Error(`HTTP ${response.status} (not retried): ${detail}`, { cause: "fatal" });
      }
      error = `HTTP ${response.status}: ${detail}`;
      retryAfter = response.headers.get("Retry-After");
    } catch (e) {
      if (e instanceof Error && e.cause === "fatal") throw e;
      error = `network error: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (attempt === MAX_ATTEMPTS) throw new Error(`gave up after ${attempt} attempts: ${error}`);
    const delay = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.random() * Math.min(60_000, 2 ** attempt * 1000);
    console.error(`  retry ${attempt} in ${(delay / 1000).toFixed(1)}s: ${error}`);
    await sleep(delay);
  }
}

// Spaces group starts so the run averages RATE images/s across all workers.
let nextStart = performance.now();
async function pace(images: number): Promise<void> {
  const start = Math.max(nextStart, performance.now());
  nextStart = start + (images / RATE) * 1000;
  await sleep(Math.max(0, start - performance.now()));
}

const done = new Set<string>();
if (existsSync(LOG)) {
  for (const line of readFileSync(LOG, "utf8").split("\n")) {
    if (line) for (const id of (JSON.parse(line) as { custom_ids: string[] }).custom_ids) done.add(id);
  }
}
// ponytail: the whole manifest and resume set live in memory; shard
// billion-image manifests into files of a few million rows, one process each.
const todo = listImages(source).filter((item) => !done.has(item.id));
const perGroup = IMAGES_PER_REQUEST * REQUESTS_PER_GROUP;
const groups: Item[][] = [];
for (let i = 0; i < todo.length; i += perGroup) groups.push(todo.slice(i, i + perGroup));
console.error(`${done.size} already submitted, ${todo.length} to go in ${groups.length} groups`);

let failures = 0;
async function submitGroup(group: Item[]): Promise<void> {
  await pace(group.length);
  const requests = [];
  const ids: string[] = [];
  for (let i = 0; i < group.length; i += IMAGES_PER_REQUEST) {
    const chunk: string[] = [];
    const uris: string[] = [];
    for (const { id, path } of group.slice(i, i + IMAGES_PER_REQUEST)) {
      let uri: string;
      try {
        uri = `data:image/${MIME[extname(path).toLowerCase()] ?? "jpeg"};base64,${(await readImage(path)).toString("base64")}`;
      } catch (e) {
        console.error(`SKIP ${id}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (uri.length > MAX_DATA_URI_CHARS) {
        console.error(`SKIP ${id}: ${uri.length} chars > ${MAX_DATA_URI_CHARS}; downscale it`);
        continue;
      }
      chunk.push(id);
      uris.push(uri);
    }
    if (chunk.length === 0) continue;
    requests.push({
      model: MODEL,
      encoding_format: "base64",
      input: uris.map((url) => [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }]),
      metadata: { custom_ids: chunk }, // response.data[i] is custom_ids[i]
    });
    ids.push(...chunk);
  }
  failures += group.length - ids.length;
  if (requests.length === 0) return;
  try {
    const groupId = await postGroup(JSON.stringify({ webhook_id: webhookId, requests }));
    const line = JSON.stringify({ groupId, custom_ids: ids, submitted_at: Date.now() / 1000 });
    appendFileSync(LOG, `${line}\n`);
    console.log(line);
  } catch (e) {
    console.error(`FAILED group of ${ids.length} starting ${ids[0]}: ${e instanceof Error ? e.message : String(e)}`);
    failures += ids.length;
  }
}

const started = performance.now();
let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < groups.length) await submitGroup(groups[next++]!);
  }),
);
const elapsed = (performance.now() - started) / 1000;
console.error(`done in ${elapsed.toFixed(1)}s (${Math.round(todo.length / elapsed)} images/s), ${failures} images not submitted`);
process.exit(failures ? 1 : 0);
