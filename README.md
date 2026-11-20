# inference-webhook-s3-worker

A Cloudflare Worker that receives [inference.net](https://inference.net) async-inference webhooks and saves each one to your Amazon S3 bucket (or any S3-compatible bucket, such as Cloudflare R2 or MinIO). A small CLI sets it up, checks it, and manages it.

- Your S3 credentials stay in your Cloudflare account as encrypted Worker secrets. inference.net never sees them, and the CLI never writes them to disk.
- The Worker returns `200` only after S3 confirms the write. On any failure it returns an error, and inference.net retries the delivery.
- Object keys come from the group or generation id, so a retried delivery overwrites the same object. You never get duplicates.

## Quick start

You need Node.js 22.18 or later, a Cloudflare account, and an S3 bucket with an access key that can `s3:PutObject` to it (see [IAM policy](#iam-policy)).

- The Cloudflare account needs the **Workers Paid** plan. Under load, the Worker used up to 12.4 ms of CPU per request (p99), above the Free plan's 10 ms limit.
- Clients that call the inference.net API must send their own `User-Agent` header. The API blocks some default ones, for example Python `urllib`'s, with HTTP 403 (error code 1010).

Optional: an inference.net API key with write access, created by a team owner or admin. With it, setup creates the webhook for you and inference.net sends a real test delivery. Run `export INFERENCE_API_KEY=...` first, or paste the key when setup asks. Without a key, setup walks you through the dashboard.

```sh
git clone https://github.com/context-labs/inference-webhook-s3-worker.git && cd inference-webhook-s3-worker
```

Then install and start setup with your package manager:

| Package manager | Command |
| --- | --- |
| npm | `npm install && npm run cli -- setup` |
| pnpm | `pnpm install && pnpm cli setup` |
| Yarn | `yarn install && yarn cli setup` |
| Bun | `bun install && bun run cli setup` |

`setup` asks for each value and checks it before it moves on:

1. **Check tools.** Node.js version, wrangler, and your Cloudflare login. It offers to run `wrangler login` if you are not logged in. It reads your inference.net API key from `INFERENCE_API_KEY`, or asks for it (press Enter to skip), and checks it.
2. **Name the Worker.** The name identifies this deployment in every later command. Worker names are unique per Cloudflare account, so setup stops if the name is taken.
3. **Connect the bucket.** Amazon S3, Cloudflare R2, or another S3-compatible service. For Amazon S3, setup finds the bucket's region itself. Setup writes a test object with your key before it deploys anything, and tells you exactly what to fix if S3 refuses.
4. **Deploy.** It stores your settings as encrypted Worker secrets, deploys the Worker, and checks that the deployed Worker can write to S3.
5. **Register the webhook.**
   - With an API key: setup creates the webhook on inference.net, named after the Worker, and stores its identifier in the Worker. Then inference.net sends a `webhook.test` delivery, and setup waits until it is in your bucket.
   - Without one: setup prints your webhook URL. In the inference.net dashboard, open **Settings** → **Integrations** → **Create Webhook**, paste the URL, and paste the webhook identifier back into setup. Then open the webhook's menu, choose **Test Webhook**, and pick any event; setup waits until the test delivery is in your bucket.

The CLI never saves your API key and never prints it. Set `INFERENCE_API_KEY` when you run later commands, and they manage the webhook too.

To check everything first without creating anything in Cloudflare, add `--dry-run` to the setup command.

### Send images

`POST https://api.inference.net/v1/async/group/embeddings` with `Authorization: Bearer $INFERENCE_API_KEY` and `webhook_id` set to the webhook identifier from setup. The response is `{"groupId": "..."}`. When every request in the group is done, inference.net sends one `slow-group.completed` webhook, and the Worker saves it as `<S3_KEY_PREFIX>groups/<groupId>.json`.

```json
{
  "webhook_id": "AhALzdz8S",
  "requests": [
    {
      "model": "google/siglip2-base-patch16-naflex",
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

- A request embeds 1–50 images. Each `input` entry is one image: a list with one user message that has one `image_url` part.
- The URL is a base64 data URL (`image/png`, `image/jpeg`, `image/gif` or `image/webp`) of at most 524,288 characters, about 384 KB of image.
- Set `"encoding_format": "base64"`. Each vector is then about 4 KB instead of about 10.5 KB as a float array. To decode one, base64-decode it to 3,072 bytes and read them as 768 little-endian float32 values.
- Put your image ids in `metadata.custom_ids`, in input order. `response.data[i]` has `index` `i` and is the vector of `custom_ids[i]`.
- The group body must stay under 32 MiB. Send 50 images per request, not one: each group is one webhook and one S3 object (see [Cost](#cost)).

[`examples/submit-embeddings.ts`](examples/submit-embeddings.ts) does this for every JPEG in a folder, 50 images per request and 10 requests per group, and prints one line per group with the `groupId` and its file paths:

```sh
export INFERENCE_API_KEY=...       # from the inference.net dashboard
export INFERENCE_WEBHOOK_ID=...    # the webhook identifier from setup
node examples/submit-embeddings.ts ./images > groups.jsonl
```

To read the vectors back, see [Object keys](#object-keys).

### Package managers

The CLI prints every next command in the form of the package manager you started it with. This README uses npm. With another package manager, replace the npm part:

| npm | pnpm | Yarn | Bun |
| --- | --- | --- | --- |
| `npm install`, `npm ci` | `pnpm install` | `yarn install` | `bun install` |
| `npm run cli -- <command>` | `pnpm cli <command>` | `yarn cli <command>` | `bun run cli <command>` |
| `npm test`, `npm run <script>` | `pnpm test`, `pnpm <script>` | `yarn test`, `yarn <script>` | `bun run test`, `bun run <script>` |
| `npx wrangler <args>` | `pnpm exec wrangler <args>` | `yarn wrangler <args>` | `bunx wrangler <args>` |

`node cli/main.ts <command>` works after any of them. Use `bun run test`, not `bun test`: `bun test` starts Bun's own test runner.

`package-lock.json` is the only lockfile in the repo, and `npm ci` installs exactly what CI tested. pnpm, Yarn, and Bun do not read it (Bun imports it on the first install), so they resolve dependencies again within the exact versions in `package.json`; CI installs and tests with all four every week. The repo ignores their lockfiles, so `git pull` never conflicts with them. `.yarnrc.yml` makes Yarn 2+ install into `node_modules`, and `.yarnrc` stops Yarn 1 from rejecting a transitive dependency that asks for a newer Node.js patch release.

## Manage the Worker

Every command takes the Worker name you chose in setup.

| Command | What it does |
| --- | --- |
| `npm run cli -- status <name>` | Checks that the Worker is deployed and reachable, has every setting, can write to S3, and when it last saved a delivery or rejected one. With `INFERENCE_API_KEY`, also checks that the webhook on inference.net exists, is on, and sends to this Worker. Exits non-zero when a check fails, including when the latest delivery failed. A new delivery can take a minute to show up (Workers KV caches reads). |
| `npm run cli -- test <name>` | Sends a test delivery to the Worker, the same request inference.net sends, and confirms that S3 stored it. With `--remote` and `INFERENCE_API_KEY`, inference.net sends a real delivery instead. |
| `npm run cli -- logs <name>` | Streams live Worker logs: one line for each saved or rejected delivery, with the event, the object key, or the reason. |
| `npm run cli -- config <name>` | Shows the settings and the webhook URL. With flags, changes them and redeploys: `--bucket`, `--region`, `--prefix`, `--endpoint`, `--webhook-id`, `--rotate-s3-keys`, `--rotate-path-secret`. With `INFERENCE_API_KEY`, `--rotate-path-secret` also sets the new URL on the webhook. |
| `npm run cli -- update <name>` | Deploys the code in this folder, for example after `git pull`. |
| `npm run cli -- list` | Lists the Workers set up from this folder. |
| `npm run cli -- destroy <name>` | Deletes the Worker and its status store, after you type its name. With `INFERENCE_API_KEY`, offers to delete the webhook too (`--yes` deletes it). Objects in S3 stay. |

`status`, `test --remote`, `config`, and `destroy` use the webhook API only for a webhook that setup created through it. For a webhook you created in the dashboard, they print the dashboard step instead.

Add `--help` to any command for its flags, their defaults, and examples. Every command ends with the command to run next, and every error ends with a fix. Colors turn off with `--no-color`, with `NO_COLOR=1`, and when the output is not a terminal.

| Exit code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | A check failed (`status`), or the command failed. The message says how to fix it. |
| `2` | Usage error: an unknown command or flag, or a missing or invalid value. |
| `130` | You pressed Ctrl+C at a question. |

Example `status` output:

```text
Status of my-embeddings
  ✔ Deployed in account 0123456789abcdef0123456789abcdef
  ✔ Reachable at https://my-embeddings.example.workers.dev
  ✔ All settings present
  ✔ S3 write works (embeddings/tests/status-probe.json)
  ✔ Last delivery 42s ago (2026-11-19T22:43:10.854Z): slow-group.completed → embeddings/groups/grp_abc.json

my-embeddings is healthy.

Next: npm run cli -- test my-embeddings   npm run cli -- logs my-embeddings
```

### Scripts and CI

- `--json` prints one JSON result on stdout (including errors, as `{"ok": false, "error", "fix"}`) and never asks questions.
- `--yes` never asks questions. A missing value fails with the flag to pass.
- `setup` reads every value from flags: `--storage aws|r2|other`, `--bucket`, `--region`, `--prefix`, `--endpoint`, `--webhook-id`, `--account-id`. Pass S3 keys as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, not as flags, so they stay out of shell history.
- With `INFERENCE_API_KEY` set, `setup` creates the webhook and sends a test delivery with no questions. The API key has no flag. Without it, `setup --yes` deploys the Worker and ends with the command that stores the webhook identifier.
- `INFERENCE_API_URL` changes the API base URL. Default: `https://relay.inference.net/api/rest`.
- Run `node cli/main.ts` in scripts. npm, pnpm, and Yarn 1 print a banner on stdout before a script's output, which breaks `--json` parsing.

```sh
INFERENCE_API_KEY=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
  node cli/main.ts setup my-embeddings --yes --bucket my-embeddings --region us-east-1 --prefix embeddings/
node cli/main.ts status my-embeddings --json | jq .ok
```

### Local state

The CLI keeps three files per Worker in `.webhook-s3/` (git-ignored):

| File | Contents |
| --- | --- |
| `<name>.json` | Account id, Worker URL, bucket, region, prefix, endpoint, status KV namespace id, and the webhook's API id when setup created it. No secrets. |
| `<name>.secrets.json` | The webhook URL path secret and the webhook identifier, which `status` and `test` need to call the Worker. Readable by your user only. |
| `<name>.wrangler.json` | The Wrangler config the CLI deploys with. |

S3 keys and the inference.net API key are never written to disk. To manage a Worker from another machine, copy these files to that machine's `.webhook-s3/`.

## Configuration

The Worker reads these values as Worker secrets. `setup` and `config` set them for you.

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

The CLI also binds a KV namespace as `STATUS`. The Worker records its last delivery and last error there, at most once a minute and once every 10 seconds per Worker instance, so the KV cost stays negligible. Without the binding the Worker works the same, but `status` cannot show recent deliveries.

## Object keys

| Event | Object key |
| --- | --- |
| `slow-group.completed` (Group API) | `<S3_KEY_PREFIX>groups/<groupId>.json` |
| `async-embedding.completed` | `<S3_KEY_PREFIX>generations/<generationId>.json` |
| `generation.completed` | `<S3_KEY_PREFIX>generations/<generationId>.json` |
| `webhook.test` (`test`, `test --remote`, and setup with an API key) | `<S3_KEY_PREFIX>tests/webhook-test.json` |

The dashboard's **Test Webhook** sends a sample `generation.completed`, `slow-group.completed`, or `async-embedding.completed` event with an id that starts with `test-`, so it lands at, for example, `<S3_KEY_PREFIX>groups/test-group-1795132156487.json`.

`setup` and `status` also write `<S3_KEY_PREFIX>tests/setup-probe.json` and `<S3_KEY_PREFIX>tests/status-probe.json` to prove that writes work.

Each object is the webhook body exactly as inference.net sent it. The [webhook docs](https://inference.net/docs/api/async/webhooks/) describe the payloads. For a group, each entry in `data.generations` holds one request and its result:

- `state` is `Success` or `Failed`. Resubmit failed requests.
- `request.metadata` is the metadata you sent with the request, for example `custom_ids`.
- `request.input` has every image URL replaced by `REDACTED`, so the object does not store the images again.
- `response.data[i].embedding` is the vector of input image `i` (`response.data[i].index` is `i`). With `"encoding_format": "base64"`, it is a base64 string of 768 little-endian float32 values.

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
| `404` | The path is not `/<WEBHOOK_PATH_SECRET>`. When the request carries the right `X-Inference-Webhook-ID`, the webhook on inference.net has an old URL: the Worker records it, and `status` shows it. |
| `405` | The method is not `POST`. |
| `500` | A required setting is missing, or `S3_KEY_PREFIX` has a character that is not allowed. |
| `502` | The S3 write failed. The Worker retries S3 `5xx` and `429` responses 3 times before it returns `502`. |

`GET /<WEBHOOK_PATH_SECRET>/status` returns the Worker's settings check, last delivery, and last error as JSON. Add `?probe=1` to also write the status probe object. The CLI's `status` command uses it.

## Security

inference.net does not sign webhook requests yet. The Worker accepts a delivery only when both of these are true:

1. The URL path is `/<WEBHOOK_PATH_SECRET>`. Only your webhook settings, your Worker, and your `.webhook-s3/` folder know it.
2. The `X-Inference-Webhook-ID` header equals `INFERENCE_WEBHOOK_ID`.

The Worker compares both values in constant time.

### IAM policy

Give the access key write access to the prefix only. `s3:DeleteObject` is optional: with it, `setup` deletes its probe object afterwards.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:DeleteObject"],
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
| S3 Standard storage: a vector is about 4 KB with `"encoding_format": "base64"`, so about 4 TB | about $95 per month |

Send 50 images per request and 10 requests per group, not one request per image. One webhook per image costs 500 times more in Worker requests and S3 `PUT`s (about $5,000 more per billion images). Cloudflare R2 charges $4.50 per million writes and $0.015 per GB-month, with no egress fees.

## Development

```sh
npm test            # Vitest
npm run typecheck   # tsc
npm run build       # wrangler bundle check, no deploy
```

### Local testing

`npx wrangler dev` runs the Worker at `http://localhost:8787` with the values in `.env` (copy `.env.example`). To use a local S3-compatible server, set `S3_ENDPOINT` (for example `http://localhost:9000`) and `S3_REGION=us-east-1`. Then send a delivery like inference.net does:

```sh
curl -X POST "http://localhost:8787/$WEBHOOK_PATH_SECRET" \
  -H "Content-Type: application/json" \
  -H "X-Inference-Webhook-ID: $INFERENCE_WEBHOOK_ID" \
  -H "X-Inference-Event: slow-group.completed" \
  -H "X-Inference-Group-ID: grp_local1" \
  -d '{"event":"slow-group.completed","groupId":"grp_local1","data":{"groupSize":0,"status":"completed","generations":[]}}'
```

## Appendix: deploy without the CLI

1. Run `npm ci` and `npx wrangler login`.
2. Copy `.env.example` to `.env` and fill it in. Generate `WEBHOOK_PATH_SECRET` with `openssl rand -hex 32`.
3. Run `npx wrangler deploy --secrets-file .env`. Wrangler prints the Worker URL, for example `https://inference-webhook-s3-worker.<your-subdomain>.workers.dev`.
4. In the inference.net dashboard, open **Settings** → **Integrations** → **Create Webhook**. Set the URL to `<Worker URL>/<WEBHOOK_PATH_SECRET>`. Copy the webhook identifier, then run `npx wrangler secret put INFERENCE_WEBHOOK_ID`.
5. In the webhook's menu, choose **Test Webhook** → **Group Completed**. Check that `<S3_KEY_PREFIX>groups/test-group-<number>.json` is now in your bucket.

This path deploys without the `STATUS` KV binding, and the CLI does not manage it.

## License

[MIT](LICENSE)
