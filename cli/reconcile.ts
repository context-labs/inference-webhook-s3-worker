#!/usr/bin/env node
/**
 * Finds completed groups whose result object is missing from S3, and writes
 * it: the same key and the same JSON the webhook would have written. See
 * "Reconcile missing results" in the README.
 */
import { createReadStream } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { AwsClient } from "aws4fetch";
import { Command, Option } from "commander";

import { hasFailure, objectUrl, SAFE_ID, SAFE_KEY_PREFIX } from "../src/index.ts";

export const DEFAULT_API_URL = "https://api.inference.net";

/** A group to check. `status` and `completedAt` come from the listing; the log knows only the id. */
export interface Group {
  id: string;
  status?: string;
  completedAt?: string;
}

/** One group from a source, and the position to resume after once it is done. */
export interface SourceItem {
  group: Group;
  position: string;
}

export interface Counts {
  /** Groups looked at. */
  checked: number;
  /** Result object already in S3. */
  present: number;
  /** Finished, but no result object in S3. */
  missing: number;
  /** Missing objects this run wrote. */
  repaired: number;
  /** Still running: nothing to save yet. */
  pending: number;
  /** Could not check or repair; the log line says why. Rerun to retry. */
  failed: number;
}

export interface S3Target {
  bucket: string;
  region: string;
  keyPrefix: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface ReconcileOptions {
  fetch: typeof fetch;
  apiUrl: string;
  apiKey: string;
  s3: S3Target;
  /** S3 existence checks in flight. */
  concurrency: number;
  /** Group downloads and S3 PUTs in flight. A large group can be tens of MB. */
  repairConcurrency: number;
  dryRun: boolean;
  /** JSON file that records progress; a rerun with the same source resumes after it. */
  checkpoint?: string;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
}

interface Checkpoint {
  source: string;
  position: string;
  counts: Counts;
}

/** Listing statuses of a group that will not change again. */
const FINAL_STATUSES = new Set(["completed", "failed", "expired", "cancelled"]);
/** Generation states that are not final yet. */
const RUNNING_STATES = new Set(["Queued", "In Progress"]);

/** Reads `path` and returns its checkpoint when it is for `source`, else null. */
export async function readCheckpoint(path: string | undefined, source: string): Promise<Checkpoint | null> {
  if (!path) return null;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const checkpoint = JSON.parse(text) as Checkpoint;
  return checkpoint.source === source ? checkpoint : null;
}

/**
 * Checks every group from `items` and repairs the missing ones. Works through
 * the source in chunks; after each chunk it saves the checkpoint, so an
 * interrupted run resumes at the last finished chunk. Rerunning is safe: a
 * repair writes the same key a delivery would.
 */
export async function reconcile(
  options: ReconcileOptions,
  source: string,
  items: AsyncIterable<SourceItem>,
  resumeCounts?: Counts,
): Promise<Counts> {
  const counts: Counts = resumeCounts ? { ...resumeCounts } : { checked: 0, present: 0, missing: 0, repaired: 0, pending: 0, failed: 0 };
  const aws = new AwsClient({
    accessKeyId: options.s3.accessKeyId,
    secretAccessKey: options.s3.secretAccessKey,
    service: "s3",
    region: options.s3.region,
  });
  const chunkSize = Math.max(options.concurrency * 4, 100);
  let chunk: SourceItem[] = [];

  for await (const item of items) {
    chunk.push(item);
    if (chunk.length >= chunkSize) {
      await runChunk(chunk);
      chunk = [];
    }
  }
  if (chunk.length > 0) await runChunk(chunk);
  if (options.checkpoint) await rm(options.checkpoint, { force: true });
  return counts;

  async function runChunk(items: SourceItem[]): Promise<void> {
    const missing = await pool(items, options.concurrency, async ({ group }) => ((await check(group)) ? group : null));
    if (!options.dryRun) {
      await pool(
        missing.filter((group): group is Group => group !== null),
        options.repairConcurrency,
        repair,
      );
    }
    if (options.checkpoint) {
      const checkpoint: Checkpoint = { source, position: items[items.length - 1]!.position, counts };
      await writeFile(`${options.checkpoint}.tmp`, JSON.stringify(checkpoint));
      await rename(`${options.checkpoint}.tmp`, options.checkpoint);
    }
    options.log(`progress ${JSON.stringify(counts)}`);
  }

  /** True when the group is finished and its result object is not in S3. */
  async function check(group: Group): Promise<boolean> {
    counts.checked++;
    if (!SAFE_ID.test(group.id)) {
      counts.failed++;
      options.log(`FAILED ${JSON.stringify(group.id)}: not a group id`);
      return false;
    }
    if (group.status !== undefined && !FINAL_STATUSES.has(group.status)) {
      counts.pending++;
      return false;
    }
    const url = s3Url(`groups/${group.id}.json`);
    try {
      // A one-byte ranged GET, not a HEAD: Node's fetch reuses connections for it, and in a
      // 5,000-key test it checked 12 times as many keys per second as HEAD. S3 bills both the same.
      const response = await send(options, () => aws.sign(url, { headers: { Range: "bytes=0-0" } }));
      await response.arrayBuffer();
      // 416: an empty object, which still exists.
      if (response.ok || response.status === 416) {
        counts.present++;
        return false;
      }
      if (response.status === 404) {
        counts.missing++;
        options.log(`missing ${group.id}`);
        return true;
      }
      throw new Error(
        response.status === 403
          ? "S3 answered 403: the key needs s3:GetObject and s3:ListBucket (without ListBucket S3 answers 403 for a missing key)"
          : `S3 GET answered ${response.status}`,
      );
    } catch (error) {
      counts.failed++;
      options.log(`FAILED ${group.id}: ${errorMessage(error)}`);
      return false;
    }
  }

  async function repair(group: Group): Promise<void> {
    try {
      const response = await send(
        options,
        () => new Request(`${options.apiUrl}/v1/async/group/${group.id}/generations`, { headers: { Authorization: `Bearer ${options.apiKey}` } }),
      );
      if (!response.ok) {
        throw new Error(
          `GET group answered ${response.status}${response.status === 404 ? " (not a group of this API key's team)" : ""}: ${(await response.text()).slice(0, 300)}`,
        );
      }
      const { generations } = (await response.json()) as { generations: Generation[] };
      if (generations.some((generation) => RUNNING_STATES.has(generation.state))) {
        counts.missing--;
        counts.pending++;
        return;
      }
      const body = JSON.stringify(groupPayload(group, generations));
      const key = `groups/${group.id}.json`;
      // Marker first, like the Worker: a saved result with a failed request always has its marker.
      if (hasFailure(new TextEncoder().encode(body).buffer as ArrayBuffer)) await put(`failures/${key}`, "{}");
      await put(key, body);
      counts.repaired++;
      options.log(`repaired ${group.id}`);
    } catch (error) {
      counts.failed++;
      options.log(`FAILED ${group.id}: ${errorMessage(error)}`);
    }
  }

  async function put(key: string, body: string): Promise<void> {
    const response = await send(options, () =>
      aws.sign(s3Url(key), {
        method: "PUT",
        // Marks objects this tool wrote, so they can be told apart from deliveries.
        headers: { "Content-Type": "application/json", "x-amz-meta-reconciled": "true" },
        body,
      }),
    );
    if (!response.ok) throw new Error(`S3 PUT ${key} answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  function s3Url(key: string): string {
    return objectUrl(
      { S3_BUCKET: options.s3.bucket, S3_REGION: options.s3.region, S3_ENDPOINT: options.s3.endpoint },
      `${options.s3.keyPrefix}${key}`,
    );
  }
}

/** A generation as `GET /v1/async/group/{id}/generations` returns it. */
export interface Generation {
  state: string;
  finishedAt?: string | null;
  request?: unknown;
  [field: string]: unknown;
}

/**
 * The `slow-group.completed` body the webhook sends for this group: the same
 * fields in the same order, with every image URL replaced by "REDACTED".
 * `timestamp` is when the group finished; the listing gives it, else the last
 * generation's finishedAt (a few hundred milliseconds before the webhook's).
 */
export function groupPayload(group: Group, generations: Generation[]): unknown {
  const finishedAt = generations
    .map((generation) => generation.finishedAt ?? "")
    .reduce((latest, at) => (at > latest ? at : latest), "");
  return {
    event: "slow-group.completed",
    timestamp: group.completedAt ?? (finishedAt || new Date().toISOString()),
    groupId: group.id,
    data: {
      groupSize: generations.length,
      status: group.status === undefined || group.status === "completed" ? "completed" : "failed",
      generations: generations.map((generation) => ({ ...generation, request: scrubImageUrls(generation.request) })),
    },
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const redactedImage = () => [{ role: "user", content: [{ type: "image_url", image_url: { url: "REDACTED" } }] }];

/**
 * Replaces image URLs the way the webhook does: an embedding `input` that
 * holds messages becomes one redacted message (one per image for a batch),
 * and every chat `image_url` part gets the URL "REDACTED".
 */
// ponytail: the webhook scrubs `input` only for embedding models; this scrubs any `input` with messages,
// so a /v1/responses group with images differs from its webhook in the image URLs only (REDACTED here).
export function scrubImageUrls(request: unknown): unknown {
  if (!isObject(request)) return request;
  const { input, messages } = request;
  if (Array.isArray(input)) {
    if (input.some(isObject)) return { ...request, input: redactedImage() };
    if (input.some((item) => Array.isArray(item) && item.some(isObject))) {
      return { ...request, input: input.map(redactedImage) };
    }
    return request;
  }
  if (Array.isArray(messages)) {
    return {
      ...request,
      messages: messages.map((message) =>
        isObject(message) && Array.isArray(message.content)
          ? {
              ...message,
              content: message.content.map((part) =>
                isObject(part) && part.type === "image_url" ? { ...part, image_url: { url: "REDACTED" } } : part,
              ),
            }
          : message,
      ),
    };
  }
  return request;
}

/**
 * Group ids from a file you wrote while submitting: one per line, either a
 * bare id or a JSON object with `groupId` (the examples' `--log` format).
 * Starts after line `after`. Positions are line numbers.
 */
export async function* logSource(path: string, after: number): AsyncGenerator<SourceItem> {
  // Splits lines itself: readline's async iterator throws "readline was closed" at the end of a
  // large file when the consumer pauses between lines, as reconcile does after every chunk.
  let line = 0;
  let rest = "";
  const read = function* (text: string): Generator<SourceItem> {
    line++;
    const trimmed = text.trim();
    if (line > after && trimmed !== "") yield { group: { id: logLineId(trimmed) }, position: String(line) };
  };
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    const lines = (rest + (chunk as string)).split("\n");
    rest = lines.pop()!;
    for (const text of lines) yield* read(text);
  }
  if (rest !== "") yield* read(rest);
}

/** The group id on one log line; an unreadable line gives "", which reconcile counts as failed. */
export function logLineId(line: string): string {
  if (!line.startsWith("{")) return line;
  try {
    const value = JSON.parse(line) as { groupId?: unknown };
    return typeof value.groupId === "string" ? value.groupId : "";
  } catch {
    return "";
  }
}

/** One page of `GET /v1/async/groups`. */
interface GroupPage {
  data: Array<{ id: string; status: string; created_at: number | string; completed_at: number | string | null }>;
  has_more: boolean;
}

/**
 * Every group of the API key's team created in [since, until), from
 * `GET /v1/async/groups`. Starts after group id `after`. Positions are group ids.
 */
export async function* listSource(
  options: Pick<ReconcileOptions, "fetch" | "apiUrl" | "apiKey" | "sleep">,
  since: Date,
  until: Date,
  after: string | undefined,
): AsyncGenerator<SourceItem> {
  let cursor = after;
  for (;;) {
    const query = new URLSearchParams({ limit: "100", since: unixSeconds(since), until: unixSeconds(until) });
    if (cursor) query.set("after", cursor);
    const url = `${options.apiUrl}/v1/async/groups?${query}`;
    const response = await send(options, () => new Request(url, { headers: { Authorization: `Bearer ${options.apiKey}` } }));
    if (!response.ok) {
      throw new Error(
        `GET /v1/async/groups answered ${response.status}${response.status === 404 ? " (this API has no group listing yet; use --from-log)" : ""}: ${(await response.text()).slice(0, 300)}`,
      );
    }
    const page = (await response.json()) as GroupPage;
    for (const group of page.data) {
      yield {
        group: { id: group.id, status: group.status, completedAt: isoTime(group.completed_at) },
        position: group.id,
      };
    }
    if (!page.has_more || page.data.length === 0) return;
    cursor = page.data[page.data.length - 1]!.id;
  }
}

function unixSeconds(date: Date): string {
  return String(Math.floor(date.getTime() / 1000));
}

/** Unix seconds or an ISO string, as ISO; undefined for null. */
function isoTime(value: number | string | null): string | undefined {
  if (value === null) return undefined;
  return typeof value === "number" ? new Date(value * 1000).toISOString() : value;
}

/** Sends a request, retrying network errors, 429 and 5xx with backoff. `make` builds a fresh, signed request each time. */
async function send(
  options: Pick<ReconcileOptions, "fetch" | "sleep">,
  make: () => Request | Promise<Request>,
  attempts = 6,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let response: Response | undefined;
    try {
      response = await options.fetch(await make());
      if (response.status !== 429 && response.status < 500) return response;
    } catch (error) {
      if (attempt >= attempts) throw error;
    }
    if (attempt >= attempts) return response!;
    await response?.body?.cancel();
    await options.sleep(Math.min(30_000, 250 * 2 ** attempt) * (0.5 + Math.random()));
  }
}

/** Runs `fn` on every item with at most `limit` in flight; results keep the input order. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]!);
      }
    }),
  );
  return results;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface CliOptions {
  fromLog?: string;
  since?: string;
  until?: string;
  bucket: string;
  region: string;
  prefix: string;
  endpoint?: string;
  apiUrl: string;
  concurrency: string;
  repairConcurrency: string;
  checkpoint?: string;
  dryRun?: boolean;
}

function usageError(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}

function parseDate(name: string, value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) usageError(`${name} must be a date, for example 2026-11-01 or 2026-11-01T12:00:00Z`);
  return date;
}

async function main(): Promise<void> {
  const program = new Command()
    .name("reconcile")
    .description(
      "Find completed groups whose result object is missing from S3, and write it: the same key and JSON the webhook would have written. Needs INFERENCE_API_KEY, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.",
    )
    .addOption(new Option("--since <date>", "check groups created at or after this time (needs GET /v1/async/groups)").conflicts("fromLog"))
    .addOption(new Option("--until <date>", "check groups created before this time (default: now)").conflicts("fromLog"))
    .option("--from-log <file>", "check the group ids in this file: one per line, a bare id or JSON with groupId")
    .addOption(new Option("--bucket <bucket>", "bucket name (or set S3_BUCKET)").default(process.env.S3_BUCKET, "S3_BUCKET").makeOptionMandatory())
    .addOption(new Option("--region <region>", "bucket region (or set S3_REGION)").default(process.env.S3_REGION, "S3_REGION").makeOptionMandatory())
    .addOption(new Option("--prefix <prefix>", "key prefix the Worker uses").default(process.env.S3_KEY_PREFIX ?? "", "S3_KEY_PREFIX, else none"))
    .addOption(new Option("--endpoint <url>", "S3-compatible endpoint, for R2 or MinIO (or set S3_ENDPOINT)").default(process.env.S3_ENDPOINT, "S3_ENDPOINT, else AWS S3"))
    .option("--api-url <url>", "inference.net API", DEFAULT_API_URL)
    .option("--concurrency <n>", "S3 existence checks in flight", "64")
    .option("--repair-concurrency <n>", "group downloads and writes in flight", "4")
    .option("--checkpoint <file>", "save progress here; rerun with the same source and file to resume")
    .option("--dry-run", "count missing objects, write nothing")
    .showHelpAfterError()
    .exitOverride((error) => process.exit(error.exitCode === 0 || error.code === "commander.help" ? 0 : 2))
    .parse();
  const cli = program.opts<CliOptions>();

  if (!cli.fromLog && !cli.since) usageError("give --since <date> (every group) or --from-log <file> (the groups in that file)");
  if (!SAFE_KEY_PREFIX.test(cli.prefix)) usageError("--prefix may only contain A-Z a-z 0-9 / _ . -");
  const [concurrency, repairConcurrency] = [cli.concurrency, cli.repairConcurrency].map(Number);
  if (!(concurrency! >= 1 && repairConcurrency! >= 1)) usageError("--concurrency and --repair-concurrency must be at least 1");
  // A dry run from a log reads only S3; everything else also calls the inference.net API.
  const needsApi = !(cli.dryRun && cli.fromLog);
  const missingEnv = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", ...(needsApi ? ["INFERENCE_API_KEY"] : [])].filter(
    (name) => !process.env[name],
  );
  if (missingEnv.length > 0) usageError(`set ${missingEnv.join(", ")}`);

  const options: ReconcileOptions = {
    fetch,
    apiUrl: cli.apiUrl.replace(/\/+$/, ""),
    apiKey: process.env.INFERENCE_API_KEY ?? "",
    s3: {
      bucket: cli.bucket,
      region: cli.region,
      keyPrefix: cli.prefix,
      endpoint: cli.endpoint,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
    concurrency: concurrency!,
    repairConcurrency: repairConcurrency!,
    dryRun: Boolean(cli.dryRun),
    checkpoint: cli.checkpoint,
    log: (line) => console.error(line),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };

  const target = `s3://${cli.bucket}/${cli.prefix}`;
  let source: string;
  let items: AsyncIterable<SourceItem>;
  let checkpoint: Checkpoint | null;
  if (cli.fromLog) {
    source = `log ${cli.fromLog} -> ${target}`;
    checkpoint = await readCheckpoint(cli.checkpoint, source);
    items = logSource(cli.fromLog, Number(checkpoint?.position ?? 0));
  } else {
    const since = parseDate("--since", cli.since!);
    const until = cli.until ? parseDate("--until", cli.until) : new Date();
    source = `list ${since.toISOString()} ${until.toISOString()} -> ${target}`;
    checkpoint = await readCheckpoint(cli.checkpoint, source);
    items = listSource(options, since, until, checkpoint?.position);
  }
  if (checkpoint) console.error(`resuming after ${checkpoint.position}`);

  const started = Date.now();
  const counts = await reconcile(options, source, items, checkpoint?.counts);
  const seconds = (Date.now() - started) / 1000;
  console.log(JSON.stringify({ ...counts, dryRun: options.dryRun, seconds, groupsPerSecond: Math.round(counts.checked / Math.max(seconds, 0.001)) }));
  // 1 while anything is left to fix: a failure, or (with --dry-run) a missing object.
  if (counts.failed > 0 || counts.missing > counts.repaired) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
