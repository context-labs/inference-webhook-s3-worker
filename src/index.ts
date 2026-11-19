import { AwsClient } from "aws4fetch";

/** Worker settings. See the configuration table in the README. */
export interface Env {
  WEBHOOK_PATH_SECRET: string;
  INFERENCE_WEBHOOK_ID: string;
  S3_BUCKET: string;
  S3_REGION: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  S3_KEY_PREFIX?: string;
  S3_ENDPOINT?: string;
}

const REQUIRED_SETTINGS = [
  "WEBHOOK_PATH_SECRET",
  "INFERENCE_WEBHOOK_ID",
  "S3_BUCKET",
  "S3_REGION",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

// Characters that need no URL encoding, so the signed path is the key as written.
const SAFE_KEY_PREFIX = /^[A-Za-z0-9/_.-]*$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

// inference.net retries 5xx itself, so keep S3 retries short: the whole
// request must finish inside the platform's 30 second delivery timeout.
const S3_RETRIES = 3;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const missing = REQUIRED_SETTINGS.filter((name) => !env[name]);
    if (missing.length > 0) {
      console.error("Missing settings", missing);
      return reply(500, `Missing settings: ${missing.join(", ")}`);
    }
    const prefix = env.S3_KEY_PREFIX ?? "";
    if (!SAFE_KEY_PREFIX.test(prefix)) {
      return reply(500, "S3_KEY_PREFIX may only contain A-Z a-z 0-9 / _ . -");
    }

    const path = new URL(request.url).pathname;
    if (!(await safeEqual(path, `/${env.WEBHOOK_PATH_SECRET}`))) {
      return reply(404, "Not found");
    }
    if (request.method !== "POST") {
      return reply(405, "Method not allowed");
    }
    const webhookId = request.headers.get("x-inference-webhook-id") ?? "";
    if (!(await safeEqual(webhookId, env.INFERENCE_WEBHOOK_ID))) {
      return reply(401, "Unauthorized");
    }

    const key = objectKey(request.headers);
    if (!key) {
      return reply(400, "Unsupported event or missing id header");
    }

    const s3 = new AwsClient({
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      service: "s3",
      region: env.S3_REGION,
      retries: S3_RETRIES,
    });
    const url = objectUrl(env, `${prefix}${key}`);
    try {
      const response = await s3.fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: await request.arrayBuffer(),
      });
      if (!response.ok) {
        console.error("S3 PUT failed", url, response.status, await response.text());
        return reply(502, `S3 PUT failed with HTTP ${response.status}`);
      }
    } catch (error) {
      console.error("S3 PUT failed", url, error);
      return reply(502, "S3 PUT failed");
    }
    return reply(200, `${prefix}${key}`);
  },
};

/**
 * The object key (before S3_KEY_PREFIX) for one delivery, or null for an
 * event this Worker does not store. Keys come from ids that stay the same on
 * every delivery attempt, so a retry overwrites the same object.
 */
export function objectKey(headers: Headers): string | null {
  const event = headers.get("x-inference-event");
  if (event === "webhook.test") {
    return "tests/webhook-test.json";
  }
  const [folder, id] =
    event === "slow-group.completed"
      ? ["groups", headers.get("x-inference-group-id")]
      : event === "generation.completed" || event === "async-embedding.completed"
        ? ["generations", headers.get("x-inference-generation-id")]
        : [null, null];
  return folder && id && SAFE_ID.test(id) ? `${folder}/${id}.json` : null;
}

/** Virtual-hosted URL on AWS; path-style on a custom endpoint (R2, MinIO). */
export function objectUrl(env: Env, key: string): string {
  return env.S3_ENDPOINT
    ? `${env.S3_ENDPOINT.replace(/\/+$/, "")}/${env.S3_BUCKET}/${key}`
    : `https://${env.S3_BUCKET}.s3.${env.S3_REGION}.amazonaws.com/${key}`;
}

/**
 * Compares SHA-256 digests byte by byte, so the time taken does not show how
 * many leading characters of a secret matched.
 */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [x, y] = await Promise.all(
    [a, b].map(async (value) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))),
  );
  let diff = 0;
  x.forEach((byte, index) => {
    diff |= byte ^ (y[index] ?? 0);
  });
  return diff === 0;
}

function reply(status: number, body: string): Response {
  return new Response(body, { status });
}
