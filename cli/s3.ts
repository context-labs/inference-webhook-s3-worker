import { AwsClient } from "aws4fetch";

import { objectUrl } from "../src/index.ts";
import { CliError } from "./output.ts";
import type { S3Settings } from "./state.ts";

export interface S3Keys {
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Proves the keys can write to the bucket before anything is deployed: PUTs
 * `<prefix>tests/setup-probe.json`, then tries to delete it. Throws a
 * CliError that says how to fix a failed write.
 */
export async function probeS3Write(settings: S3Settings, keys: S3Keys): Promise<{ key: string; deleted: boolean }> {
  const s3 = new AwsClient({ ...keys, service: "s3", region: settings.region, retries: 1 });
  const key = `${settings.keyPrefix}tests/setup-probe.json`;
  const url = objectUrl({ S3_BUCKET: settings.bucket, S3_REGION: settings.region, S3_ENDPOINT: settings.endpoint ?? undefined }, key);

  let response: Response;
  try {
    response = await s3.fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ probe: true, at: new Date().toISOString() }),
    });
  } catch (error) {
    throw new CliError(
      `Could not reach ${new URL(url).origin}: ${String(error)}`,
      settings.endpoint ? "Check the S3 endpoint URL." : "Check the bucket name and region.",
    );
  }
  if (!response.ok) {
    throw s3WriteError(settings, response.status, await response.text(), response.headers.get("x-amz-bucket-region"));
  }

  const deleted = await s3.fetch(url, { method: "DELETE" }).then(
    (deleteResponse) => deleteResponse.ok,
    () => false,
  );
  return { key, deleted };
}

/**
 * The region of an Amazon S3 bucket, or null when S3 does not say. S3 names it
 * in the x-amz-bucket-region header even for a request without credentials.
 */
export async function bucketRegion(fetch: typeof globalThis.fetch, bucket: string): Promise<string | null> {
  try {
    const response = await fetch(`https://s3.amazonaws.com/${bucket}`, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    return response.headers.get("x-amz-bucket-region");
  } catch {
    return null;
  }
}

function s3WriteError(settings: S3Settings, status: number, body: string, bucketRegion: string | null): CliError {
  const s3Code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? `HTTP ${status}`;
  const where = `${settings.bucket}/${settings.keyPrefix}`;
  switch (s3Code) {
    case "NoSuchBucket":
      return new CliError(`Bucket ${settings.bucket} does not exist.`, "Check the bucket name, or create the bucket first.");
    case "PermanentRedirect":
    case "AuthorizationHeaderMalformed":
    case "IllegalLocationConstraintException":
      return new CliError(
        `Bucket ${settings.bucket} is not in region ${settings.region}.`,
        bucketRegion ? `Use region ${bucketRegion}.` : "Use the region the bucket was created in.",
      );
    case "InvalidAccessKeyId":
      return new CliError("The access key id does not exist.", "Check S3_ACCESS_KEY_ID, or create a new access key.");
    case "SignatureDoesNotMatch":
      return new CliError(
        "The secret access key does not match the access key id.",
        "Paste the secret access key again, or check AWS_SECRET_ACCESS_KEY.",
      );
    case "AccessDenied":
      return new CliError(
        `The key cannot write to ${where}.`,
        settings.endpoint
          ? `Check the bucket name, and give the key write access to bucket ${settings.bucket} (for Cloudflare R2: an API token with Object Read & Write on that bucket).`
          : `Allow s3:PutObject on arn:aws:s3:::${where}* (see "IAM policy" in the README).`,
      );
    default:
      return new CliError(`S3 rejected the test write to ${where}: ${s3Code}.`, "Check the bucket, region, and key permissions.");
  }
}
