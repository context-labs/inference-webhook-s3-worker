# Examples: submit image embeddings and read the results

These scripts send images to the inference.net async Group API with `webhook_id`
set to the webhook from `setup`. The Worker saves each finished group to
`<S3_KEY_PREFIX>groups/<groupId>.json`, and `read_results.py` reads the vectors back.

| File | What it does |
| --- | --- |
| [`curl.sh`](curl.sh) | One group with 1–50 images. Use it as a smoke test. |
| [`python/submit.py`](python/submit.py) | Python 3.10+, standard library only. Reads a folder or an `id,path` CSV, then submits groups with a target rate, retries and resume. |
| [`submit-embeddings.ts`](submit-embeddings.ts) | Does the same in Node.js 22.18+, with no dependencies. |
| [`python/read_results.py`](python/read_results.py) | Yields `(custom_id, np.float32 vector)` from a group object, local or `s3://`. |
| [`typescript/embed-minimal.ts`](typescript/embed-minimal.ts) | The smallest correct Node.js 22.18+ client: one group of up to 2,500 images, no retries. |
| [`typescript/read-results.ts`](typescript/read-results.ts) | Yields `[customId, Float32Array]` from a local group object. Download it with `aws s3 cp` first. |

inference.net gives you the model id for your account. Set it in `INFERENCE_MODEL`.

## Quick start

```sh
export INFERENCE_API_KEY=...        # inference.net API key with write access
export INFERENCE_WEBHOOK_ID=...     # webhook identifier from setup
export INFERENCE_MODEL=...          # your embedding model id

examples/curl.sh a.jpg b.jpg        # prints {"groupId":"...","groupSize":1}

python examples/python/submit.py ./images --rate 1000
# or
RATE=1000 node examples/submit-embeddings.ts ./images
```

Both submitters print one JSON line per accepted group and append it to `submitted.jsonl`:
`{"groupId": "...", "custom_ids": [...], "submitted_at": ...}`.

To read results, run `pip install -r examples/python/requirements.txt` first:

```sh
python examples/python/read_results.py s3://my-bucket/embeddings/groups/<groupId>.json
```

```python
from read_results import load, iter_group
failed = []
for custom_id, vec in iter_group(load("s3://my-bucket/embeddings/groups/abc.json"), failed):
    ...  # vec: 1-D np.float32, L2-normalized
# `failed` now holds the custom ids of failed requests. Resubmit them.
```

### TypeScript quick start

Node.js 22.18+ runs the `.ts` files directly. They need no dependencies.

```sh
node examples/typescript/embed-minimal.ts a.jpg b.jpg   # prints {"groupId":"...","groupSize":1}
aws s3 cp s3://my-bucket/embeddings/groups/<groupId>.json .
node examples/typescript/read-results.ts <groupId>.json
```

```ts
import { iterGroup, load } from "./examples/typescript/read-results.ts";
const failed: string[] = [];
for (const [customId, vec] of iterGroup(load("abc.json"), failed)) {
  // vec: Float32Array, L2-normalized
}
// `failed` now holds the custom ids of failed requests. Resubmit them.
```

## Request shape

Send `POST https://api.inference.net/v1/async/group/embeddings` with these headers:
`Authorization: Bearer $INFERENCE_API_KEY`, `Content-Type: application/json`, and a
`User-Agent` that you choose. The edge rejects some default user agents, for example
Python `urllib`'s, with `403 error code: 1010`.

```json
{
  "webhook_id": "<webhook identifier>",
  "requests": [
    {
      "model": "<your model id>",
      "encoding_format": "base64",
      "input": [
        [{ "role": "user", "content": [{ "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,/9j/4AAQ..." } }] }],
        [{ "role": "user", "content": [{ "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,/9j/4BBQ..." } }] }]
      ],
      "metadata": { "custom_ids": ["cats/0001.jpg", "cats/0002.jpg"] }
    }
  ]
}
```

- Each `input` entry is one image: a list with one user message that has one `image_url` part.
- `metadata.custom_ids` holds your ids in input order. `response.data[i]` (`index` = `i`) is the vector of `custom_ids[i]`.
- The response is `{"groupId": "...", "groupSize": <number of requests>}`.
- With `encoding_format: "base64"`, each vector is base64 of little-endian float32 values. It is about 3 times smaller than `"float"`.
- Add `"embed_dtype": "float16"` next to `encoding_format` to get [half-size vectors](#half-size-vectors-float16).
- An image can also be an `https://` URL that inference.net fetches. See [Image URLs](#image-urls).
- Send an `Idempotency-Key` header, so a retried POST does not make a second group. See [Retries](#retries).

## Image URLs

Instead of a data URL, `image_url.url` can be an `https://` URL, for example a presigned S3 GET.
The body then stays small, so a group can hold 50 requests of 50 images.

```sh
python examples/python/submit.py manifest.csv --presign-hours 72 --requests-per-group 50
```

- `--presign-hours` sends each `s3://` path in the manifest as a presigned GET URL, signed
  locally by boto3 with SigV4 for the region in `AWS_REGION` or your profile. That must be the
  region of the images' bucket. A manifest path that starts with `https://` is always sent as
  it is, also by `submit-embeddings.ts`.
- Presign for at least 72 hours: a request can wait up to 72 hours before it runs. S3 allows
  at most 7 days (168 hours), and only for URLs signed with an IAM user's access key. A URL
  signed with temporary credentials (SSO, an assumed role, STS) stops working when that
  session ends.
- URL rules, checked at submit (`400` otherwise): `https` only, a public host name (no IP
  address, no `localhost`), no `user:password@`, at most 4,096 characters.
- inference.net fetches each URL when the request runs. The image must be PNG, JPEG, GIF or
  WebP and at most 384 KiB. `408`, `429` and `5xx` answers are retried twice.
- A URL that cannot be fetched fails only its own request: `state: "Failed"`, and
  `stateMessage` says why, for example `the server answered HTTP 403 (an expired presigned URL
  answers 403)`. [Reconcile](#reconcile-with-s3) resubmits those ids with new URLs.
- S3 serves at least 5,500 GET requests per second per prefix, and answers `503 SlowDown`
  while it scales up. Above that rate, spread the images across prefixes, for example keys
  that start with a hash.
- The stored request and the webhook show every image as `"REDACTED"`, so your URLs are not
  saved with the results.

## Half-size vectors (float16)

Add `"embed_dtype": "float16"` to each request (`--embed-dtype float16`, or
`EMBED_DTYPE=float16` for `submit-embeddings.ts`). Each base64 vector is then little-endian
float16: 1,536 bytes and 2,048 characters for 768 dimensions, instead of 3,072 bytes and 4,096
characters. Webhooks and S3 objects are about half the size.

- Cosine similarity with the float32 vector is above 0.9999999 for normalized vectors.
- The default is `"float32"`. `encoding_format: "float"` ignores `embed_dtype`.
- The stored request keeps `embed_dtype`, so `read_results.py` and `read-results.ts` decode each
  generation the right way and always return float32 vectors. In NumPy:
  `np.frombuffer(base64.b64decode(s), dtype="<f2")`.

## Limits

| Scope | Limit |
| --- | --- |
| Group (one POST) | 1–50 requests, and a body of at most 32 MiB |
| Request | 1–50 images |
| Image | A data URI of at most 524,288 characters (about 384 KB of image): `image/jpeg`, `png`, `gif` or `webp`. Or an `https://` URL of at most 4,096 characters, to an image of at most 384 KiB. |
| Rate limit | Your team's requests per minute. **One group POST counts as 1 request**, however many images it holds. |

Errors:

| Status | Cause |
| --- | --- |
| `400` | Bad input. The body names the field, for example `requests.0.input.0.0.content.0.image_url.url`. |
| `409` | A POST with the same `Idempotency-Key` is still running. Retry with the same key and body. |
| `401` | Bad API key. |
| `403` | The edge blocked a default user agent. |
| `413` | The body is larger than 32 MiB. |
| `422` | The `Idempotency-Key` was already used with a different body in the last hour. |
| `429` | Rate limited. |

## Batching

Send **50 requests of 50 images each (2,500 images per group) with image URLs.** With data URLs,
send as many requests as fit in 32 MiB: about 35 requests of 50 images at 18 KB per image, and
10 (the submitters' default) for images of up to about 60 KB.

- 500 images of about 13.5 KB are about 9 MB of JSON. 500 images of 27 KB are about 18 MB. Both are under 32 MiB.
- 2,500 presigned URLs of about 1,900 characters are about 5 MB.
- Each group makes one webhook and one S3 object, so larger groups cost less on the Worker and in S3.
- A failed request fails only its own images. The other requests in the group still land.

## Concurrency and rate

| Target | Groups/s | Group POSTs/min (counts against the rate limit) | Upload at 13.5 KB/image |
| --- | --- | --- | --- |
| 1,000 images/s | 2 | 120 | about 18 MB/s |
| 5,000 images/s | 10 | 600 | about 90 MB/s (0.7 Gbit/s) |
| 7,500 images/s | 15 | 900 | about 135 MB/s (1.1 Gbit/s) |

- At 500 images per group, the rate limit is not the bottleneck. Upload bandwidth and base64 encoding are.
- Groups in flight = groups/s × POST time. One 400-image group took about 2.5 s from one test host, including file reads and encoding. At 15 groups/s, you need about 40–50 groups in flight.
- `--rate` (`RATE`) spaces group starts across all workers, so a run holds a steady rate. `--concurrency` (`CONCURRENCY`) caps the groups in flight. If `done in ...` reports less than your rate, raise the concurrency.
- Above a few thousand images/s, run several processes. Give each one its own manifest shard and its own `--log`, and split the rate between them.

## Retries

The submitters already do this:

- They retry `409`, `429`, `5xx`, network errors and timeouts with exponential backoff and full jitter (a random wait of 0–2^attempt s, capped at 60 s), up to 8 attempts. A `Retry-After` header overrides the backoff.
- They do not retry other `4xx` responses. Fix the input, for example downscale the image, and rerun.
- When a POST fails, they resend the **whole group**. The API accepts all of a group or none of it.
- Each POST carries `Idempotency-Key: <SHA-256 of the body>`, and every retry sends the same body
  and key. If the connection drops after the server accepted the group, the retry gets the same
  `groupId` back (with `Idempotent-Replayed: true`), not a second group. A rerun after a crash
  builds the same body for the same files, so it also gets the first group back. Presigned URLs
  are signed again on a rerun, so there the rerun makes a new group.
- The key works for 1 hour after the first success. inference.net still accepts a group when it
  cannot check the key, so a duplicate is rare but possible. Key results by `custom_id` (last
  write wins). Never count result objects.
- [Reconcile](#reconcile-with-s3) adds a new salt to the key on each run, so a resubmit is
  never answered with the lost group it replaces.
- They skip an image that is over the size limit with a `SKIP` line, so it does not fail its whole group.

### Resume

At start, the submitters skip the ids that are already in the log. After a crash, a
`FAILED` group, or a `SKIP` for an image you have since fixed, rerun the same command.
Only the missing ids go out. The exit code is `1` while any image is still unsubmitted.

The manifest and the log stay in memory. For billions of images, split the job into
manifests of a few million rows, with one process and one log for each.

### Reconcile with S3

The log says what was submitted, not what landed. A group can be accepted and still have no
result: a request in it failed, or its webhook never reached the Worker within inference.net's
3 days of retries. To resubmit only the ids that have no result in your bucket, add `--reconcile`
with your bucket and `S3_KEY_PREFIX`:

```sh
pip install boto3
python examples/python/submit.py ./images --reconcile s3://my-bucket/embeddings/ --dry-run
# reconcile: 4 logged groups in S3 (1 read), 1 still running, 0 never arrived
# 45 have a result or are running, 5 to go in 1 groups
python examples/python/submit.py ./images --reconcile s3://my-bucket/embeddings/
```

- It LISTs `<prefix>groups/` and `<prefix>failures/groups/`, and compares them with the log.
  It reads (GETs) only groups that have a failure marker: one LIST request per 1,000 groups,
  plus one GET per group with a failed request.
- For a group with a failed request, the Worker also writes a small marker object at
  `<prefix>failures/groups/<groupId>.json`. Reconcile reads that group and resubmits only the
  ids of its failed requests.
- A logged group with no object counts as still running for 24 hours after its submit. Change
  it with `--pending-hours`. A group can still land later, because inference.net retries a
  webhook for about 3 days. You then get its ids twice, so key results by `custom_id`.
- If `npm run cli -- status <name>` fails, fix the Worker first. Resubmitted groups need it too.
- Resubmitted groups go into the same log, so you can run reconcile again.
- The access key needs `s3:ListBucket` on the bucket and `s3:GetObject` on the prefix. For R2 or
  another S3-compatible store, set `AWS_ENDPOINT_URL_S3` to its endpoint.
- The log of `submit-embeddings.ts` has the same format, so reconcile works with it too.

Workers deployed before failure markers keep working, but write no markers. Run `git pull` and
`npm run cli -- update <name>` to get them. For groups saved before the update, add `--get-all`:
reconcile then reads every saved group.

## Reading results

The Worker writes one object per group, `<S3_KEY_PREFIX>groups/<groupId>.json`, when
every request in the group is done:

```text
data.generations[]          one entry per request, NOT in submission order
  .state                    "Success" or "Failed"
  .request.metadata         the metadata you sent: {"custom_ids": [...]}
  .request.input            images replaced by "REDACTED"
  .response.data[]          {"index": i, "embedding": "<base64>"}
```

- Map each generation through **its own** `request.metadata.custom_ids`, by `index`. Never map by array position across generations: their order differs from the request order.
- A request with `state: "Failed"` has no vectors. Resubmit its custom ids, or run
  [reconcile](#reconcile-with-s3). The Worker also writes `<prefix>failures/groups/<groupId>.json`
  for such a group.
- The vectors are L2-normalized, so cosine similarity is a dot product. `read_results.py` warns when a norm is not about 1.
