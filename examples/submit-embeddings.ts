/**
 * Submits every JPEG under a folder as async image-embedding groups. Each
 * request embeds up to 50 images; each group holds up to 10 requests (500
 * images). Each request sets `metadata.custom_ids` to the file paths of its
 * images, relative to the folder, in input order: `response.data[i]` is the
 * vector of `custom_ids[i]`.
 *
 * Prints one JSON line per group: {"groupId": "...", "customIds": [...]}.
 * The Worker stores that group at `<S3_KEY_PREFIX>groups/<groupId>.json`.
 *
 * Usage (Node.js 22.18 or later):
 *   INFERENCE_API_KEY=... INFERENCE_WEBHOOK_ID=... \
 *     node examples/submit-embeddings.ts ./images > groups.jsonl
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const API_URL = "https://api.inference.net/v1/async/group/embeddings";
const MODEL = "google/siglip2-base-patch16-naflex";
const IMAGES_PER_REQUEST = 50;
// 500 images of ~27 KB are ~18 MB of base64, under the 32 MiB body cap.
const REQUESTS_PER_GROUP = 10;
const IMAGES_PER_GROUP = IMAGES_PER_REQUEST * REQUESTS_PER_GROUP;
const CONCURRENCY = 4;
const MAX_ATTEMPTS = 5;

const folder = process.argv[2];
const apiKey = process.env.INFERENCE_API_KEY;
const webhookId = process.env.INFERENCE_WEBHOOK_ID;
if (!folder || !apiKey || !webhookId) {
  console.error("Usage: INFERENCE_API_KEY=... INFERENCE_WEBHOOK_ID=... node examples/submit-embeddings.ts <folder>");
  process.exit(1);
}

const files = (await readdir(folder, { recursive: true })).filter((file) => /\.jpe?g$/i.test(file)).sort();
const groups = chunk(files, IMAGES_PER_GROUP);

let nextGroup = 0;
async function submitLoop(): Promise<void> {
  while (nextGroup < groups.length) {
    const group = groups[nextGroup++];
    if (group) {
      await submitGroup(group);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, submitLoop));
console.error(`Submitted ${files.length} images in ${groups.length} groups`);

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

async function submitGroup(paths: string[]): Promise<void> {
  const requests = await Promise.all(
    chunk(paths, IMAGES_PER_REQUEST).map(async (requestPaths) => ({
      model: MODEL,
      // Each vector arrives as base64 of 768 little-endian float32 values: ~4 KB instead of ~10.5 KB of floats.
      encoding_format: "base64",
      // One user message with one `image_url` part per image, in order.
      input: await Promise.all(
        requestPaths.map(async (path) => [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${(await readFile(join(folder, path))).toString("base64")}` },
              },
            ],
          },
        ]),
      ),
      metadata: { custom_ids: requestPaths },
    })),
  );
  const body = JSON.stringify({ requests, webhook_id: webhookId });

  for (let attempt = 1; ; attempt++) {
    const response = await fetch(API_URL, {
      method: "POST",
      // The API blocks some default User-Agent headers, so send your own.
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "User-Agent": "inference-webhook-s3-worker-example" },
      body,
    });
    if (response.ok) {
      const { groupId } = (await response.json()) as { groupId: string };
      console.log(JSON.stringify({ groupId, customIds: paths }));
      return;
    }
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === MAX_ATTEMPTS) {
      throw new Error(`Group starting at ${paths[0]} failed: HTTP ${response.status} ${await response.text()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
  }
}
