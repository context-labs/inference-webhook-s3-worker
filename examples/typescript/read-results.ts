/**
 * Read embeddings from stored group objects (groups/<groupId>.json).
 * Download them first, for example: aws s3 cp s3://my-bucket/embeddings/groups/abc.json .
 *
 * Usage (Node.js 22.18+, no dependencies):
 *   node examples/typescript/read-results.ts abc.json def.json ...
 *
 * As a library:
 *   import { iterGroup, load } from "./read-results.ts";
 *   const failed: string[] = [];
 *   for (const [customId, vec] of iterGroup(load("abc.json"), failed)) { ... }  // vec: Float32Array, L2-normalized
 *   // `failed` now holds the custom ids of failed requests. Resubmit them.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface Generation {
  id: string;
  state: "Success" | "Failed";
  request: { metadata: { custom_ids: string[] } };
  response?: { data: { index: number; embedding: string | number[] }[] };
}
export interface GroupObject { data: { generations: Generation[] } }

export function load(path: string): GroupObject {
  return JSON.parse(readFileSync(path, "utf8")) as GroupObject;
}

/** base64 = little-endian float32 bytes; an array = encoding_format "float". */
export function decode(embedding: string | number[]): Float32Array {
  if (Array.isArray(embedding)) return Float32Array.from(embedding);
  const bytes = Buffer.from(embedding, "base64");
  if (bytes.length === 0 || bytes.length % 4 !== 0) throw new Error(`bad embedding: ${bytes.length} bytes`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  return Float32Array.from({ length: bytes.length / 4 }, (_, i) => view.getFloat32(i * 4, true));
}

/**
 * Yield [customId, vector] for every image in a group. Each generation is one request:
 * map response.data[] (by .index) through ITS OWN request.metadata.custom_ids.
 * Generations are NOT in submission order, so never map by position across them.
 * Custom ids of failed requests are appended to `failed`.
 */
export function* iterGroup(doc: GroupObject, failed: string[] = []): Generator<[string, Float32Array]> {
  for (const gen of doc.data.generations) {
    const ids = gen.request.metadata.custom_ids;
    if (gen.state !== "Success" || !gen.response) {
      failed.push(...ids);
      continue;
    }
    if (gen.response.data.length !== ids.length) {
      throw new Error(`generation ${gen.id}: ${gen.response.data.length} vectors for ${ids.length} ids`);
    }
    for (const item of gen.response.data) yield [ids[item.index]!, decode(item.embedding)];
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("Usage: node examples/typescript/read-results.ts groups/<groupId>.json ...");
    process.exit(2);
  }
  let total = 0;
  const failed: string[] = [];
  for (const path of paths) {
    for (const [customId, vec] of iterGroup(load(path), failed)) {
      const norm = Math.hypot(...vec);
      if (Math.abs(norm - 1) > 1e-3) console.error(`WARNING ${customId}: norm ${norm.toFixed(5)}`);
      total++;
    }
  }
  console.log(`${total} vectors OK, ${failed.length} failed ids to resubmit`);
  for (const id of failed) console.error(`FAILED ${id}`);
}
