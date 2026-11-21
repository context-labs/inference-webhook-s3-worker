# inference-webhook-s3-worker

Save every [inference.net](https://inference.net) async result to your own S3 bucket, using a Cloudflare Worker you deploy in about two minutes.

```text
your code ──POST──▶ inference.net async API ──webhook──▶ this Worker ──PUT──▶ your S3 bucket
```

- **No lost results.** The Worker returns `200` only after S3 confirms the write. Any failure makes inference.net retry, for about 3 days.
- **No duplicates.** The object key comes from the group or generation id, so a retried delivery overwrites the same object.
- **Your keys stay yours.** S3 keys are encrypted Worker secrets in your Cloudflare account. inference.net never sees them, and the CLI never writes them to disk.
- **Any S3 API.** Works with Amazon S3, Cloudflare R2, MinIO and other S3-compatible storage.

## Prerequisites

- [ ] Node.js 22.18 or later
- [ ] A Cloudflare account on the **Workers Paid** plan. The Worker uses about 15 ms of CPU per request at p99 (23 ms at p99.9) at 5,000 images/s, above the Free plan's 10 ms limit.
- [ ] An S3 bucket, plus an access key that can `s3:PutObject` to your key prefix. See the IAM policy under [Reference](#reference).
- [ ] An inference.net API key

## Quick start

```sh
git clone https://github.com/context-labs/inference-webhook-s3-worker.git
cd inference-webhook-s3-worker
npm install
export INFERENCE_API_KEY=...   # lets setup create the webhook for you
npm run cli -- setup
```

`setup` asks for each value and checks it before it continues: tools and Cloudflare login, Worker name, bucket, deploy, then webhook. When it finishes, inference.net has sent a real test delivery, and the Worker has saved it to your bucket:

```text
  ✔ webhook.test delivery received and saved to embeddings/tests/webhook-test.json

Done. my-embeddings is live.
  Webhook URL:   https://my-embeddings.example.workers.dev/3f9c…
  Objects go to: my-embeddings/embeddings/{groups,generations}/<id>.json

Next: npm run cli -- status my-embeddings   npm run cli -- test my-embeddings   npm run cli -- logs my-embeddings
```

Add `--dry-run` to run every check, including the S3 write, without creating anything in Cloudflare.

<details>
<summary><b>pnpm, Yarn or Bun</b></summary>

Replace the npm commands. The CLI prints its next commands in the form of the package manager that started it.

| npm | pnpm | Yarn | Bun |
| --- | --- | --- | --- |
| `npm install` | `pnpm install` | `yarn install` | `bun install` |
| `npm run cli -- <command>` | `pnpm cli <command>` | `yarn cli <command>` | `bun run cli <command>` |
| `npm test`, `npm run <script>` | `pnpm test`, `pnpm <script>` | `yarn test`, `yarn <script>` | `bun run test`, `bun run <script>` |
| `npx wrangler <args>` | `pnpm exec wrangler <args>` | `yarn wrangler <args>` | `bunx wrangler <args>` |

- `node cli/main.ts <command>` works after any of them.
- Use `bun run test`, not `bun test`. `bun test` starts Bun's own test runner.
- `package-lock.json` is the only lockfile, and `npm ci` installs exactly what CI tested. pnpm, Yarn and Bun do not read it (Bun imports it on the first install), so they resolve dependencies again within the exact versions in `package.json`. CI installs and tests with all four every week.
- The repo ignores the other lockfiles, so `git pull` never conflicts with them.
- `.yarnrc.yml` makes Yarn 2+ install into `node_modules`. `.yarnrc` stops Yarn 1 from rejecting a transitive dependency that asks for a newer Node.js patch release.

</details>

<details>
<summary><b>Set up without an API key</b></summary>

Skip `export INFERENCE_API_KEY`, or press Enter when setup asks for the key. After deploy, setup prints your webhook URL. Then:

1. In the inference.net dashboard, open **Settings** → **Integrations** → **Create Webhook**, and paste the URL.
2. Paste the webhook identifier back into setup.
3. Open the webhook's menu, choose **Test Webhook**, and pick any event. Setup waits until the test delivery is in your bucket.

The key needs write access, and a team owner or admin must create it. The CLI never saves or prints it. Set `INFERENCE_API_KEY` when you run later commands, and they manage the webhook too.

</details>

## Send images

Send a group to `POST https://api.inference.net/v1/async/group/embeddings`. Set `webhook_id` to the webhook identifier from setup.

```sh
curl https://api.inference.net/v1/async/group/embeddings \
  -H "Authorization: Bearer $INFERENCE_API_KEY" \
  -H "Content-Type: application/json" \
  -H "User-Agent: my-embedder/1.0" \
  -d '{
    "webhook_id": "AhALzdz8S",
    "requests": [{
      "model": "your-embedding-model-id",
      "encoding_format": "base64",
      "input": [
        [{ "role": "user", "content": [{ "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,/9j/4AAQ..." } }] }],
        [{ "role": "user", "content": [{ "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,/9j/4BBQ..." } }] }]
      ],
      "metadata": { "custom_ids": ["cats/0001.jpg", "cats/0002.jpg"] }
    }]
  }'
# {"groupId": "grp_abc"}
```

When every request in the group is done, inference.net sends one `slow-group.completed` webhook, and the Worker saves it to S3.

- Each `input` entry is one image: a list with one user message that has one `image_url` part.
- Put your own ids in `metadata.custom_ids`, in input order.
- Set `"encoding_format": "base64"`. A vector is then about 4 KB instead of about 10.5 KB as a float array.
- Send your own `User-Agent`. The API blocks some default ones, for example Python `urllib`'s, with HTTP 403 (error code 1010).

Full clients in Python, Node.js and curl are in [`examples/`](examples/).

<details>
<summary><b>Limits</b></summary>

- A request embeds 1–50 images.
- Each image is a base64 data URL (`image/png`, `image/jpeg`, `image/gif` or `image/webp`) of at most 524,288 characters, about 384 KB of image.
- The group body must stay under 32 MiB.
- Send 50 images per request, not one. Each group is one webhook and one S3 object. See Cost under [Reference](#reference).

</details>

## What lands in S3

Each group is saved at `<prefix>groups/<groupId>.json`. The object is the webhook body exactly as inference.net sent it. Each entry in `data.generations` holds one request and its result:

```jsonc
{
  "event": "slow-group.completed",
  "groupId": "grp_abc",
  "data": {
    "generations": [
      {
        "state": "Success",                                  // or "Failed": resubmit it
        "request": {
          "metadata": { "custom_ids": ["cats/0001.jpg", "cats/0002.jpg"] },
          "input": ["…"]                                     // image URLs replaced by "REDACTED"
        },
        "response": {
          "data": [
            { "index": 0, "embedding": "AACAPwAAAEA…" },     // vector of custom_ids[0]
            { "index": 1, "embedding": "AABAQAAAgEA…" }
          ]
        }
      }
    ]
  }
}
```

This shows only the fields you need. The [webhook docs](https://inference.net/docs/api/async/webhooks/) describe the full payload.

`response.data[i]` is the vector of `custom_ids[i]`. To list one line per image:

```sh
jq -c '.data.generations[] | .request.metadata.custom_ids as $ids | .state as $state | .response.data[]? | {custom_id: $ids[.index], state: $state, embedding}' grp_abc.json
```

An `embedding` is a base64 string of little-endian float32 values. For a 768-dimension model that is 3,072 bytes. To decode one:

```sh
python3 -c 'import base64, struct, sys; print((lambda b: struct.unpack(f"<{len(b)//4}f", b))(base64.b64decode(sys.argv[1])))' "$EMBEDDING"
```

<details>
<summary><b>All object keys</b></summary>

| Event | Object key |
| --- | --- |
| `slow-group.completed` (Group API) | `<S3_KEY_PREFIX>groups/<groupId>.json` |
| `async-embedding.completed` | `<S3_KEY_PREFIX>generations/<generationId>.json` |
| `generation.completed` | `<S3_KEY_PREFIX>generations/<generationId>.json` |
| `webhook.test` (`test`, `test --remote`, and setup with an API key) | `<S3_KEY_PREFIX>tests/webhook-test.json` |

- The dashboard's **Test Webhook** sends a sample `generation.completed`, `slow-group.completed` or `async-embedding.completed` event with an id that starts with `test-`. It lands at, for example, `<S3_KEY_PREFIX>groups/test-group-1795132156487.json`.
- When a request in a delivery failed, the Worker also writes a small marker object at `<S3_KEY_PREFIX>failures/<key>`, for example `failures/groups/<groupId>.json`. [Reconcile](examples/README.md#reconcile-with-s3) lists these markers to find results with failed requests.
- `setup` and `status` also write `<S3_KEY_PREFIX>tests/setup-probe.json` and `<S3_KEY_PREFIX>tests/status-probe.json` to prove that writes work.

</details>

## Manage it

Every command takes the Worker name you chose in setup. Add `--help` to any command for its flags and examples.

| Command | What it does |
| --- | --- |
| `npm run cli -- status <name>` | Checks the Worker end to end, and shows the last saved or rejected delivery. Exits 1 when a check fails. |
| `npm run cli -- test <name>` | Sends a test delivery through the Worker and confirms that S3 stored it. `--remote` has inference.net send it. |
| `npm run cli -- logs <name>` | Streams live logs: for each delivery, a request line and a `Saved …` or `Rejected … with HTTP <status>` line. The request line says `Ok` also for a rejected delivery: `Ok` means only that the Worker did not crash. |
| `npm run cli -- config <name>` | Shows the settings and the webhook URL. With flags, changes them and redeploys. |
| `npm run cli -- update <name>` | Deploys the code in this folder, for example after `git pull`. |
| `npm run cli -- list` | Lists the Workers set up from this folder. |
| `npm run cli -- destroy <name>` | Deletes the Worker and its status store, after you type its name. S3 objects stay. |

A healthy Worker:

```text
$ npm run cli -- status my-embeddings

Status of my-embeddings
  ✔ Deployed in account 0123456789abcdef0123456789abcdef
  ✔ Reachable at https://my-embeddings.example.workers.dev
  ✔ All settings present
  ✔ S3 write works (embeddings/tests/status-probe.json)
  ✔ Last delivery 42s ago (2026-11-19T22:43:10.854Z): slow-group.completed → embeddings/groups/grp_abc.json

my-embeddings is healthy.
```

<details>
<summary><b>Command details and exit codes</b></summary>

- `status` checks that the Worker is deployed and reachable, has every setting, and can write to S3. With `INFERENCE_API_KEY`, it also checks that the webhook on inference.net exists, is on, and sends to this Worker. It exits non-zero when the latest delivery failed. A new delivery can take a minute to show up, because Workers KV caches reads.
- `test --remote` needs `INFERENCE_API_KEY`.
- `config` flags: `--bucket`, `--region`, `--prefix`, `--endpoint`, `--webhook-id`, `--rotate-s3-keys`, `--rotate-path-secret`. With `INFERENCE_API_KEY`, `--rotate-path-secret` also sets the new URL on the webhook.
- `destroy` with `INFERENCE_API_KEY` offers to delete the webhook too. `--yes` deletes it.
- `status`, `test --remote`, `config` and `destroy` use the webhook API only for a webhook that setup created through it. For a webhook you created in the dashboard, they print the dashboard step instead.
- Every command ends with the command to run next, and every error ends with a fix.
- Colors turn off with `--no-color`, with `NO_COLOR=1`, and when the output is not a terminal.

| Exit code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | A check failed (`status`), or the command failed. The message says how to fix it. |
| `2` | Usage error: an unknown command or flag, or a missing or invalid value. |
| `130` | You pressed Ctrl+C at a question. |

</details>

## Reference

<details>
<summary><b>IAM policy</b></summary>

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

</details>

<details>
<summary><b>Retries and response codes</b></summary>

inference.net retries every response outside `200`–`299`: after 5 s, 30 s, 2 min, 10 min, 30 min, 1 h, 2 h, and then every 4 h, for 24 attempts (about 3 days). No other status code stops retries. If you fix a configuration error within that window, you lose no results. Object keys come from the group or generation id, so a retried delivery overwrites the same object.

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

</details>

<details>
<summary><b>Security</b></summary>

inference.net does not sign webhook requests yet. The Worker accepts a delivery only when both of these are true:

1. The URL path is `/<WEBHOOK_PATH_SECRET>`. Only your webhook settings, your Worker, and your `.webhook-s3/` folder know it.
2. The `X-Inference-Webhook-ID` header equals `INFERENCE_WEBHOOK_ID`.

The Worker compares both values in constant time.

</details>

<details>
<summary><b>Configuration</b></summary>

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

</details>

<details>
<summary><b>Scripts and CI</b></summary>

- `--json` prints one JSON result on stdout (errors too, as `{"ok": false, "error", "fix"}`) and never asks questions.
- `--yes` never asks questions. A missing value fails with the flag to pass.
- `setup` reads every value from flags: `--storage aws|r2|other`, `--bucket`, `--region`, `--prefix`, `--endpoint`, `--webhook-id`, `--account-id`. Pass S3 keys as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` rather than `--access-key-id` and `--secret-access-key`, so they stay out of shell history.
- With `INFERENCE_API_KEY` set, `setup` creates the webhook and sends a test delivery with no questions. The API key has no flag. Without it, `setup --yes` deploys the Worker and ends with the command that stores the webhook identifier.
- `INFERENCE_API_URL` changes the API base URL. Default: `https://relay.inference.net/api/rest`.
- Run `node cli/main.ts` in scripts. npm, pnpm and Yarn 1 print a banner on stdout before a script's output, which breaks `--json` parsing.

```sh
INFERENCE_API_KEY=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
  node cli/main.ts setup my-embeddings --yes --bucket my-embeddings --region us-east-1 --prefix embeddings/
node cli/main.ts status my-embeddings --json | jq .ok
```

</details>

<details>
<summary><b>Local state</b></summary>

The CLI keeps three files per Worker in `.webhook-s3/` (git-ignored):

| File | Contents |
| --- | --- |
| `<name>.json` | Account id, Worker URL, bucket, region, prefix, endpoint, status KV namespace id, and the webhook's API id when setup created it. No secrets. |
| `<name>.secrets.json` | The webhook URL path secret and the webhook identifier, which `status` and `test` need to call the Worker. Readable by your user only. |
| `<name>.wrangler.json` | The Wrangler config the CLI deploys with. |

S3 keys and the inference.net API key are never written to disk. To manage a Worker from another machine, copy these files to that machine's `.webhook-s3/`.

</details>

<details>
<summary><b>Cost</b></summary>

Approximate list prices for one billion 768-dimension embeddings, sent in groups of 500 images (2 million webhooks):

| Item | Cost |
| --- | --- |
| Cloudflare Workers Paid: $5/month with 10 million requests, then $0.30 per million | about $5 |
| S3 `PUT` requests: $0.005 per 1,000 | about $10 |
| S3 Standard storage: a vector is about 4 KB with `"encoding_format": "base64"`, so about 4 TB | about $95 per month |

Send 50 images per request and 10 requests per group, not one request per image. One webhook per image costs 500 times more in Worker requests and S3 `PUT`s (about $5,000 more per billion images). Cloudflare R2 charges $4.50 per million writes and $0.015 per GB-month, with no egress fees.

</details>

<details>
<summary><b>Development and local testing</b></summary>

```sh
npm test            # Vitest
npm run typecheck   # tsc
npm run build       # wrangler bundle check, no deploy
```

`npx wrangler dev` runs the Worker at `http://localhost:8787` with the values in `.env` (copy `.env.example`). To use a local S3-compatible server, set `S3_ENDPOINT` (for example `http://localhost:9000`) and `S3_REGION=us-east-1`. Then send a delivery like inference.net does:

```sh
curl -X POST "http://localhost:8787/$WEBHOOK_PATH_SECRET" \
  -H "Content-Type: application/json" \
  -H "X-Inference-Webhook-ID: $INFERENCE_WEBHOOK_ID" \
  -H "X-Inference-Event: slow-group.completed" \
  -H "X-Inference-Group-ID: grp_local1" \
  -d '{"event":"slow-group.completed","groupId":"grp_local1","data":{"groupSize":0,"status":"completed","generations":[]}}'
```

</details>

<details>
<summary><b>Deploy without the CLI</b></summary>

1. Run `npm ci` and `npx wrangler login`.
2. Copy `.env.example` to `.env` and fill it in. Generate `WEBHOOK_PATH_SECRET` with `openssl rand -hex 32`.
3. Run `npx wrangler deploy --secrets-file .env`. Wrangler prints the Worker URL, for example `https://inference-webhook-s3-worker.<your-subdomain>.workers.dev`.
4. In the inference.net dashboard, open **Settings** → **Integrations** → **Create Webhook**. Set the URL to `<Worker URL>/<WEBHOOK_PATH_SECRET>`. Copy the webhook identifier, then run `npx wrangler secret put INFERENCE_WEBHOOK_ID`.
5. In the webhook's menu, choose **Test Webhook** → **Group Completed**. Check that `<S3_KEY_PREFIX>groups/test-group-<number>.json` is now in your bucket.

This path deploys without the `STATUS` KV binding, and the CLI does not manage it.

</details>

## License

[MIT](LICENSE)
