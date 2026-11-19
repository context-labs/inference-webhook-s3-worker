# inference-webhook-s3-worker

A Cloudflare Worker that receives [inference.net](https://inference.net) async-inference webhooks and saves each one to your Amazon S3 bucket (or any S3-compatible bucket, such as Cloudflare R2 or MinIO).

- Your S3 credentials stay in your Cloudflare account as encrypted Worker secrets. inference.net never sees them.
- The Worker returns `200` only after S3 confirms the write. On any failure it returns an error, and inference.net retries the delivery.
- Object keys come from the group or generation id, so a retried delivery overwrites the same object. You never get duplicates.

## Deploy

You need Node.js 22.18 or later, a Cloudflare account, an S3 bucket, and an access key that can `s3:PutObject` to it (see [IAM policy](#iam-policy)).

1. Clone and install:
   ```sh
   git clone https://github.com/context-labs/inference-webhook-s3-worker.git
   cd inference-webhook-s3-worker
   npm ci
   npx wrangler login
   ```
2. Copy `.env.example` to `.env` and fill it in. Generate `WEBHOOK_PATH_SECRET` with `openssl rand -hex 32`.
3. Deploy. Wrangler prints the Worker URL, for example `https://inference-webhook-s3-worker.<your-subdomain>.workers.dev`.
   ```sh
   npx wrangler deploy --secrets-file .env
   ```
4. On the inference.net dashboard, go to **Settings** → **Integrations** → **Create Webhook**. Set the URL to `<Worker URL>/<WEBHOOK_PATH_SECRET>`. Copy the webhook identifier it gives you, then store it:
   ```sh
   npx wrangler secret put INFERENCE_WEBHOOK_ID
   ```
5. Click **Test** on the webhook. Check that `<S3_KEY_PREFIX>tests/webhook-test.json` is now in your bucket.

Then send requests with that webhook identifier (see [Example client](#example-client)).

## Configuration

Set every value as a Worker secret: in `.env` with `wrangler deploy --secrets-file .env`, or one at a time with `npx wrangler secret put <NAME>`. The Worker returns `500` and names each missing value until all required values are set.

| Variable | Required | Description | Example |
| --- | --- | --- | --- |
| `WEBHOOK_PATH_SECRET` | Yes | Random string. The Worker accepts requests only at `/<WEBHOOK_PATH_SECRET>`. | output of `openssl rand -hex 32` |
| `INFERENCE_WEBHOOK_ID` | Yes | The webhook identifier from the inference.net dashboard. Requests must carry it in `X-Inference-Webhook-ID`. | `AhALzdz8S` |
| `S3_BUCKET` | Yes | Bucket name. | `my-embeddings` |
| `S3_REGION` | Yes | Bucket region. Use `auto` for Cloudflare R2. | `us-east-1` |
| `S3_ACCESS_KEY_ID` | Yes | Access key id. | `AKIA...` |
| `S3_SECRET_ACCESS_KEY` | Yes | Secret access key. | |
| `S3_KEY_PREFIX` | No | Prepended to every object key. Allowed characters: `A-Z a-z 0-9 / _ . -`. Default: empty. | `embeddings/` |
| `S3_ENDPOINT` | No | S3-compatible endpoint. The Worker then uses path-style URLs (`<endpoint>/<bucket>/<key>`). Default: `https://<bucket>.s3.<region>.amazonaws.com`. Set it to `https://s3.<region>.amazonaws.com` if your bucket name contains dots. | `https://<account-id>.r2.cloudflarestorage.com` |

## Object keys

| Event | Object key |
| --- | --- |
| `slow-group.completed` (Group API) | `<S3_KEY_PREFIX>groups/<groupId>.json` |
| `async-embedding.completed` | `<S3_KEY_PREFIX>generations/<generationId>.json` |
| `generation.completed` | `<S3_KEY_PREFIX>generations/<generationId>.json` |
| `webhook.test` (dashboard **Test** button) | `<S3_KEY_PREFIX>tests/webhook-test.json` |

Each object is the webhook body exactly as inference.net sent it. The [webhook docs](https://inference.net/docs/api/async/webhooks/) describe the payloads. For a group, each entry in `data.generations` holds one request and its result:

- `state` is `Success` or `Failed`. Resubmit failed requests.
- `request.metadata` is the metadata you sent with the request, for example `custom_ids`.
- `request.input` has every image URL replaced by `REDACTED`, so the object does not store the images again.
- `response.data[i].embedding` is the vector of input image `i` (`response.data[i].index` is `i`).

To list the vectors in a group object, one line per image:

```sh
jq -c '.data.generations[] | .request.metadata.custom_ids as $ids | .state as $state | .response.data[]? | {custom_id: $ids[.index], state: $state, embedding}' grp_abc.json
```

## Responses and retries

inference.net retries every response outside `200`–`299`: after 5 s, 30 s, 2 min, 10 min, 30 min, 1 h, 2 h, and then every 4 h, for 24 attempts (about 3 days). No other status code stops retries. If you fix a configuration error within that window, you lose no results.

| Status | Cause |
| --- | --- |
| `200` | The object is in S3. The body is the object key. |
| `400` | Unknown event type, or the id header is missing. |
| `401` | `X-Inference-Webhook-ID` does not match `INFERENCE_WEBHOOK_ID`. |
| `404` | The path is not `/<WEBHOOK_PATH_SECRET>`. |
| `405` | The method is not `POST`. |
| `500` | A required setting is missing, or `S3_KEY_PREFIX` has a character that is not allowed. |
| `502` | The S3 write failed. The Worker retries S3 `5xx` and `429` responses 3 times before it returns `502`. |

## Security

inference.net does not sign webhook requests yet. The Worker accepts a request only when both of these are true:

1. The URL path is `/<WEBHOOK_PATH_SECRET>`. Only your webhook settings and your Worker know it.
2. The `X-Inference-Webhook-ID` header equals `INFERENCE_WEBHOOK_ID`.

The Worker compares both values in constant time.

### IAM policy

Give the access key write access to the prefix only:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::my-embeddings/embeddings/*"
    }
  ]
}
```

## Cost

Approximate list prices for one billion 768-dimension embeddings, sent in groups of 500 images (2 million webhooks):

| Item | Cost |
| --- | --- |
| Cloudflare Workers Paid: $5/month with 10 million requests, then $0.30 per million | about $5 |
| S3 `PUT` requests: $0.005 per 1,000 | about $10 |
| S3 Standard storage: a vector is 10–16 KB as JSON, so 10–16 TB | about $230–370 per month |

Send 50 images per request and 10 requests per group, not one request per image. One webhook per image costs 500 times more in Worker requests and S3 `PUT`s (about $5,000 more per billion images). Cloudflare R2 charges $4.50 per million writes and $0.015 per GB-month, with no egress fees.

## Example client

[`examples/submit-embeddings.ts`](examples/submit-embeddings.ts) sends every JPEG in a folder to `/v1/async/group/embeddings` as base64 data URLs: 50 images per request, 10 requests per group. Each request carries `metadata.custom_ids`, the file paths of its images in input order, so `response.data[i]` is the vector of `custom_ids[i]`. The script prints one line per group with the `groupId` and its file paths.

`input` is a list of 1–50 images. Each image is one user message with one `image_url` part. The URL must be a base64 data URL (`image/png`, `image/jpeg`, `image/gif` or `image/webp`) of at most 524,288 characters, which is about 384 KB of image. The whole group body must stay under 32 MiB.

```json
{
  "model": "google/siglip2-base-patch16-naflex",
  "input": [
    [{ "role": "user", "content": [{ "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,/9j/4AAQ..." } }] }],
    [{ "role": "user", "content": [{ "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,/9j/4BBQ..." } }] }]
  ],
  "metadata": { "custom_ids": ["cats/0001.jpg", "cats/0002.jpg"] }
}
```

```sh
export INFERENCE_API_KEY=...       # from the inference.net dashboard
export INFERENCE_WEBHOOK_ID=...    # from deploy step 4
node examples/submit-embeddings.ts ./images > groups.jsonl
```

## Local testing

`npx wrangler dev` runs the Worker at `http://localhost:8787` with the values in `.env`. To use a local S3-compatible server, set `S3_ENDPOINT` (for example `http://localhost:9000`) and `S3_REGION=us-east-1`. Then send a delivery like inference.net does:

```sh
curl -X POST "http://localhost:8787/$WEBHOOK_PATH_SECRET" \
  -H "Content-Type: application/json" \
  -H "X-Inference-Webhook-ID: $INFERENCE_WEBHOOK_ID" \
  -H "X-Inference-Event: slow-group.completed" \
  -H "X-Inference-Group-ID: grp_local1" \
  -d '{"event":"slow-group.completed","groupId":"grp_local1","data":{"groupSize":0,"status":"completed","generations":[]}}'
```

## Development

```sh
npm test            # Vitest
npm run typecheck   # tsc
npm run build       # wrangler bundle check, no deploy
```

## License

[MIT](LICENSE)
