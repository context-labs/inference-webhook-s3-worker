/**
 * The smallest correct client: embed up to 2,500 images in one group (50 requests x 50 images).
 * Prints {"groupId":"...","groupSize":N}. The Worker saves the results to groups/<groupId>.json.
 * For large jobs with rate control, retries and resume, use ../submit-embeddings.ts.
 *
 * Usage (Node.js 22.18+, no dependencies):
 *   export INFERENCE_API_KEY=... INFERENCE_WEBHOOK_ID=... INFERENCE_MODEL=...
 *   node examples/typescript/embed-minimal.ts a.jpg b.png ...   # custom id = the path you pass
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

interface EmbeddingRequest {
  model: string;
  encoding_format: "base64";
  input: { role: "user"; content: { type: "image_url"; image_url: { url: string } }[] }[][];
  metadata: { custom_ids: string[] }; // response.data[i] is the vector of custom_ids[i]
}
interface GroupResponse { groupId: string; groupSize: number }

const IMAGES_PER_REQUEST = Number(process.env.IMAGES_PER_REQUEST ?? 50); // 1-50
const files = process.argv.slice(2);
const { INFERENCE_API_KEY: apiKey, INFERENCE_WEBHOOK_ID: webhookId } = process.env;
if (!apiKey || !webhookId || files.length === 0 || files.length > 50 * IMAGES_PER_REQUEST) {
  console.error(`Usage: INFERENCE_API_KEY=... INFERENCE_WEBHOOK_ID=... node embed-minimal.ts <1-${50 * IMAGES_PER_REQUEST} images>`);
  process.exit(2);
}

const requests: EmbeddingRequest[] = [];
for (let i = 0; i < files.length; i += IMAGES_PER_REQUEST) {
  const chunk = files.slice(i, i + IMAGES_PER_REQUEST);
  requests.push({
    model: process.env.INFERENCE_MODEL ?? "your-embedding-model-id", // inference.net gives you the model id
    encoding_format: "base64",
    input: chunk.map((file) => {
      const mime = extname(file).slice(1).toLowerCase().replace("jpg", "jpeg");
      const url = `data:image/${mime};base64,${readFileSync(file).toString("base64")}`;
      return [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }];
    }),
    metadata: { custom_ids: chunk },
  });
}

const body = JSON.stringify({ webhook_id: webhookId, requests });
const response = await fetch(`${process.env.INFERENCE_API_URL ?? "https://api.inference.net"}/v1/async/group/embeddings`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    // Running this again on the same files within 1 hour returns the same group, not a second one.
    "Idempotency-Key": createHash("sha256").update(body).digest("hex"),
    "User-Agent": "embeddings-minimal/1.0",
  },
  body,
});
if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
console.log(JSON.stringify((await response.json()) as GroupResponse));
