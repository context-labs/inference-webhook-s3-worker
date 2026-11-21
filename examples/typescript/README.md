# TypeScript examples

Send images to the inference.net async Group API and read the vectors back from your bucket. No dependencies, no build step.

| File | What it does | Use it when |
| --- | --- | --- |
| [`embed-minimal.ts`](embed-minimal.ts) | Sends 1–2,500 images as one group (up to 50 requests of 50 images). Prints the `groupId`. | You want to try the API or read the smallest correct client. |
| [`read-results.ts`](read-results.ts) | Reads a saved `groups/<groupId>.json` and yields `[customId, Float32Array]`. Works as a CLI or a library. | Every time you read results. |
| [`../submit-embeddings.ts`](../submit-embeddings.ts) | The full submitter: folder or CSV input, target rate, concurrency, retries, resume. | Bulk jobs. Graduate to it when you need rate control, retries, or resume after a crash. |

## Prerequisites

- **Node.js 22.18+.** It runs `.ts` files directly.
- A deployed Worker. Run `npm run cli -- setup` from the repo root first ([README](../../README.md#quick-start)).
- Three environment variables:

| Variable | Where it comes from |
| --- | --- |
| `INFERENCE_API_KEY` | An inference.net API key with write access. |
| `INFERENCE_WEBHOOK_ID` | The webhook identifier. `setup` prints it (`Created webhook <identifier> ...`), and `npm run cli -- config <name>` shows it. |
| `INFERENCE_MODEL` | The embedding model id that inference.net gives you. |

## Quick start

From the repo root:

```sh
export INFERENCE_API_KEY=... INFERENCE_WEBHOOK_ID=... INFERENCE_MODEL=...

node examples/typescript/embed-minimal.ts cats/0001.jpg cats/0002.jpg
# {"groupId":"...","groupSize":1}
```

`groupSize` is the number of requests (50 images each), not images. When every request is done, the Worker saves the group to `<S3_KEY_PREFIX>groups/<groupId>.json`. Download it and read it:

```sh
aws s3 cp s3://my-bucket/embeddings/groups/<groupId>.json .
node examples/typescript/read-results.ts <groupId>.json
# 2 vectors OK, 0 failed ids to resubmit
```

Failed ids go to stderr as `FAILED <customId>` lines. Missing env or arguments print a usage line and exit `2`.

## How it works

Each request carries your ids in `metadata.custom_ids`, in the same order as `input` ([`embed-minimal.ts`](embed-minimal.ts)):

```ts
requests.push({
  model: process.env.INFERENCE_MODEL ?? "your-embedding-model-id",
  encoding_format: "base64",
  input: chunk.map((file) => { /* one data: URI image per entry */ }),
  metadata: { custom_ids: chunk },
});
```

Results map back through **each generation's own** `custom_ids`, by `index` ([`read-results.ts`](read-results.ts)):

```ts
for (const gen of doc.data.generations) {
  const ids = gen.request.metadata.custom_ids;
  // ...
  for (const item of gen.response.data) yield [ids[item.index]!, decode(item.embedding)];
}
```

Generations are not in submission order. Never map by position across them.

## Use it in your code

Import from `read-results.ts`, or copy its three functions into your project:

```ts
import { decode, iterGroup, load } from "./examples/typescript/read-results.ts";

const failed: string[] = [];
for (const [customId, vec] of iterGroup(load("abc.json"), failed)) {
  // vec: Float32Array, L2-normalized, so cosine similarity is a dot product
}
// `failed` now holds the custom ids of failed requests. Resubmit them.
```

- `load(path)` parses a group object from disk.
- `iterGroup(doc, failed)` yields `[customId, vector]` and collects failed ids.
- `decode(embedding)` turns one base64 (or `float` array) embedding into a `Float32Array`.

## Gotchas

- **Set your own `User-Agent`.** The edge rejects some default user agents with `403`. `embed-minimal.ts` sends `embeddings-minimal/1.0`.
- **Limits:** at most 50 images per request, 50 requests per group, and 32 MiB per POST.
- **Base64 vectors are little-endian float32**, or float16 when the request had `"embed_dtype": "float16"`. `iterGroup()` reads that from each stored request; `decode(embedding, "float16")` does it by hand.
- **One failed request does not fail the group.** Its images come back in `failed`. The rest still land.
- **Key by id, not position.** `embed-minimal.ts` sends an `Idempotency-Key` (the SHA-256 of the body), so running it again on the same files within 1 hour returns the first group. A duplicate group is still possible, so key results by `customId`.

More detail on limits, batching, and retries: [`../README.md`](../README.md).
