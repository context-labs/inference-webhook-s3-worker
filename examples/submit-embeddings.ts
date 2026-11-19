/**
 * Submits every JPEG under a folder as async image-embedding groups of up to
 * 50 requests. Each request sets `metadata.custom_id` to the file path
 * relative to the folder, so you can match each vector in S3 to its image.
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
const GROUP_SIZE = 50;
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
const groups: string[][] = [];
for (let start = 0; start < files.length; start += GROUP_SIZE) {
  groups.push(files.slice(start, start + GROUP_SIZE));
}

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

async function submitGroup(paths: string[]): Promise<void> {
  const requests = await Promise.all(
    paths.map(async (path) => ({
      model: MODEL,
      input: `data:image/jpeg;base64,${(await readFile(join(folder, path))).toString("base64")}`,
      metadata: { custom_id: path },
    })),
  );
  const body = JSON.stringify({ requests, webhook_id: webhookId });

  for (let attempt = 1; ; attempt++) {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
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
