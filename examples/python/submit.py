"""Submit images to inference.net async image embeddings, in groups.

Each group = up to 10 requests x 50 images = 500 images, one webhook, one S3 object
(with --presign-hours, use --requests-per-group 50: 2,500 images, since URLs are small).
Every submitted group is printed and appended to a JSONL log; rerunning with the same log
skips images that are already submitted, so an interrupted run resumes.

Usage (Python 3.10+, stdlib only; boto3 for s3:// paths and --reconcile):
  export INFERENCE_API_KEY=... INFERENCE_WEBHOOK_ID=... INFERENCE_MODEL=...
  python submit.py ./images                   # every .jpg/.jpeg/.png/.webp under a folder; id = relative path
  python submit.py manifest.csv               # CSV with header "id,path"; path may be s3://bucket/key (needs boto3)
  python submit.py manifest.csv --rate 2000 --concurrency 16 --log submitted.jsonl
  python submit.py manifest.csv --presign-hours 72 --requests-per-group 50   # s3:// paths sent as presigned URLs
  python submit.py ./images --embed-dtype float16                            # half-size vectors
  python submit.py manifest.csv --reconcile s3://my-bucket/embeddings/ --dry-run   # count ids with no result in S3
  python submit.py manifest.csv --reconcile s3://my-bucket/embeddings/             # resubmit only those

Exit code 1 if any group or image failed; rerun the same command to retry only those.
"""

import argparse
import base64
import csv
import hashlib
import json
import os
import random
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

API_URL = os.environ.get("INFERENCE_API_URL", "https://api.inference.net") + "/v1/async/group/embeddings"
# inference.net gives you the model id for your account.
MODEL = os.environ.get("INFERENCE_MODEL", "your-embedding-model-id")
MAX_DATA_URI_CHARS = 512 * 1024  # per image; larger images are rejected by the API
MAX_URL_CHARS = 4096
MAX_ATTEMPTS = 8
MIME = {".jpg": "jpeg", ".jpeg": "jpeg", ".png": "png", ".webp": "webp", ".gif": "gif"}


def list_images(source: str) -> list[tuple[str, str]]:
    """(custom_id, path) pairs from a folder or an "id,path" CSV manifest."""
    if source.endswith(".csv"):
        with open(source, newline="") as f:
            return [(row["id"], row["path"]) for row in csv.DictReader(f)]
    root = Path(source)
    return sorted(
        (str(p.relative_to(root)), str(p))
        for p in root.rglob("*")
        if p.suffix.lower() in MIME and p.is_file()
    )


_s3 = threading.local()


def s3_client():
    if not hasattr(_s3, "client"):
        import boto3  # pip install boto3; one client per thread
        from botocore.config import Config

        # SigV4: boto3 still presigns with SigV2 in us-east-1 unless told otherwise.
        _s3.client = boto3.client("s3", config=Config(signature_version="s3v4"))
    return _s3.client


def read_image(path: str) -> bytes:
    """S3 HOOK: replace or extend this to read from your own storage."""
    if path.startswith("s3://"):
        bucket, key = path[5:].split("/", 1)
        return s3_client().get_object(Bucket=bucket, Key=key)["Body"].read()
    return Path(path).read_bytes()


def image_url(path: str, presign_seconds: int) -> str:
    """The image_url.url for one image: an https:// path as is, an s3:// path presigned when
    presign_seconds is set (signed locally, no request to S3), anything else as a data URL."""
    if path.startswith("https://"):
        return path
    if path.startswith("s3://") and presign_seconds:
        bucket, key = path[5:].split("/", 1)
        params = {"Bucket": bucket, "Key": key}
        return s3_client().generate_presigned_url("get_object", Params=params, ExpiresIn=presign_seconds)
    mime = MIME.get(Path(path).suffix.lower(), "jpeg")
    return f"data:image/{mime};base64,{base64.b64encode(read_image(path)).decode()}"


def idempotency_key(body: bytes, salt: str) -> str:
    """Same body and salt, same key: inference.net answers a repeat within 1 hour with the
    group it already accepted. A key from the body, not only the ids, never collides with a
    resend whose presigned URLs were signed again (that would be HTTP 422)."""
    return hashlib.sha256(salt.encode() + body).hexdigest()


def post_group(body: bytes, api_key: str, salt: str) -> str:
    """POST one group; retry 409/429/5xx/network errors with backoff + jitter. Returns groupId.

    Every attempt sends the same body and Idempotency-Key, so a retry after a timeout returns
    the first group instead of making a second one. If inference.net cannot check the key, it
    still accepts the group, so a duplicate stays possible: key results by custom_id.
    """
    key = idempotency_key(body, salt)
    for attempt in range(1, MAX_ATTEMPTS + 1):
        req = urllib.request.Request(API_URL, data=body, method="POST", headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Idempotency-Key": key,
            "User-Agent": "embeddings-submit/1.0",  # some default user agents (e.g. Python urllib) get 403
        })
        retry_after = None
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.load(resp)["groupId"]
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:500]
            # 409: the first POST with this key is still running.
            if e.code not in (409, 429) and e.code < 500:
                raise RuntimeError(f"HTTP {e.code} (not retried): {detail}") from None
            error = f"HTTP {e.code}: {detail}"
            retry_after = e.headers.get("Retry-After")
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            error = f"network error: {e}"
        if attempt == MAX_ATTEMPTS:
            raise RuntimeError(f"gave up after {attempt} attempts: {error}")
        delay = float(retry_after) if retry_after and retry_after.isdigit() else random.uniform(0, min(60, 2**attempt))
        print(f"  retry {attempt} in {delay:.1f}s: {error}", file=sys.stderr)
        time.sleep(delay)
    raise AssertionError("unreachable")


def reconcile(entries: list[dict], s3, s3_url: str, pending_hours: float, get_all: bool) -> set[str]:
    """Ids from the log that need no resubmit: their result is in S3, or their group is still running.

    s3_url is s3://<bucket>/<S3_KEY_PREFIX>. LISTs of <prefix>groups/ and <prefix>failures/groups/
    cover every group. A saved group counts in full, unless the Worker marked it in failures/
    (a request in it failed): then one GET finds the ids of its successful requests. get_all GETs
    every saved group, for groups saved by a Worker that writes no markers. A group that is not
    saved counts while it is younger than pending_hours: inference.net may still be running or
    delivering it.
    """
    bucket, _, prefix = s3_url.removeprefix("s3://").partition("/")
    keys = {f"groups/{entry['groupId']}.json": entry for entry in entries}

    def listed(sub: str) -> set[str]:
        """Keys under prefix + sub, without the prefix, that belong to a logged group."""
        pages = s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix + sub)
        found = (obj["Key"][len(prefix) :] for page in pages for obj in page.get("Contents", []))
        return {key for key in found if key.removeprefix("failures/") in keys}

    def succeeded_ids(key: str) -> list[str]:
        doc = json.load(s3.get_object(Bucket=bucket, Key=prefix + key)["Body"])
        gens = doc["data"]["generations"]
        return [i for gen in gens if gen["state"] == "Success" for i in gen["request"]["metadata"]["custom_ids"]]

    saved, marked = listed("groups/"), listed("failures/groups/")
    done: set[str] = set()
    to_get, pending, missing = [], 0, 0
    for key, entry in keys.items():
        if key not in saved:
            if time.time() - entry["submitted_at"] < pending_hours * 3600:
                done.update(entry["custom_ids"])
                pending += 1
            else:
                missing += 1
        elif get_all or f"failures/{key}" in marked:
            to_get.append(key)
        else:
            done.update(entry["custom_ids"])
    with ThreadPoolExecutor(16) as pool:
        for ids in pool.map(succeeded_ids, to_get):
            done.update(ids)
    print(f"reconcile: {len(saved)} logged groups in S3 ({len(to_get)} read), {pending} still running, "
          f"{missing} never arrived", file=sys.stderr)
    return done


class Pacer:
    """Spaces group starts so the run averages `rate` images/s across all threads."""

    def __init__(self, rate: float):
        self.rate, self.next, self.lock = rate, time.monotonic(), threading.Lock()

    def wait(self, images: int) -> None:
        with self.lock:
            now = time.monotonic()
            start = max(self.next, now)
            self.next = start + images / self.rate
        time.sleep(start - now)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", help="folder of images, or id,path CSV manifest")
    ap.add_argument("--log", default="submitted.jsonl", help="JSONL of submitted groups (resume state)")
    ap.add_argument("--rate", type=float, default=1000, help="target images/s (default 1000)")
    ap.add_argument("--concurrency", type=int, default=8, help="groups in flight (default 8)")
    ap.add_argument("--images-per-request", type=int, default=50, help="1-50 (default 50)")
    ap.add_argument("--requests-per-group", type=int, default=10, help="1-50 (default 10)")
    ap.add_argument("--reconcile", metavar="S3_URL",
                    help="s3://<bucket>/<S3_KEY_PREFIX>: skip only ids whose result is in S3, not every logged id")
    ap.add_argument("--pending-hours", type=float, default=24,
                    help="with --reconcile: a logged group not in S3 yet counts as running for this long (default 24)")
    ap.add_argument("--get-all", action="store_true",
                    help="with --reconcile: also read groups without a failures/ marker (saved by an older Worker)")
    ap.add_argument("--dry-run", action="store_true", help="print what would be submitted, submit nothing")
    ap.add_argument("--presign-hours", type=float, default=0,
                    help="send s3:// images as presigned GET URLs valid this long, 72-168, instead of data URLs")
    ap.add_argument("--embed-dtype", choices=["float32", "float16"], default="float32",
                    help="float16 halves each vector (default float32)")
    args = ap.parse_args()
    if args.presign_hours and not 72 <= args.presign_hours <= 168:
        ap.error("--presign-hours must be 72-168: a request can wait up to 72 h, and S3 signs for at most 7 days")
    presign_seconds = int(args.presign_hours * 3600)
    # A new salt for each reconcile run, so its resubmits never match a key used before.
    salt = f"reconcile-{time.time_ns()}" if args.reconcile else ""

    entries = []
    if os.path.exists(args.log):
        with open(args.log) as f:
            entries = [json.loads(line) for line in f]
    if args.reconcile:
        import boto3  # pip install boto3

        done = reconcile(entries, boto3.client("s3"), args.reconcile, args.pending_hours, args.get_all)
    else:
        done = {i for entry in entries for i in entry["custom_ids"]}
    # ponytail: the whole manifest and resume set live in memory; shard
    # billion-image manifests into files of a few million rows, one process each.
    todo = [item for item in list_images(args.source) if item[0] not in done]
    per_group = args.images_per_request * args.requests_per_group
    groups = [todo[i : i + per_group] for i in range(0, len(todo), per_group)]
    skipped = "have a result or are running" if args.reconcile else "already submitted"
    print(f"{len(done)} {skipped}, {len(todo)} to go in {len(groups)} groups", file=sys.stderr)
    if args.dry_run:
        return
    api_key, webhook_id = os.environ["INFERENCE_API_KEY"], os.environ["INFERENCE_WEBHOOK_ID"]

    log, log_lock, pacer = open(args.log, "a"), threading.Lock(), Pacer(args.rate)
    failures = 0

    def submit(group: list[tuple[str, str]]) -> None:
        nonlocal failures
        pacer.wait(len(group))
        requests, ids = [], []
        for i in range(0, len(group), args.images_per_request):
            chunk, uris = [], []
            for custom_id, path in group[i : i + args.images_per_request]:
                try:
                    uri = image_url(path, presign_seconds)
                except Exception as e:  # unreadable file or object: report, keep going
                    print(f"SKIP {custom_id}: {e}", file=sys.stderr)
                    continue
                limit = MAX_DATA_URI_CHARS if uri.startswith("data:") else MAX_URL_CHARS
                if len(uri) > limit:
                    print(f"SKIP {custom_id}: {len(uri)} chars > {limit}; downscale it or shorten the URL", file=sys.stderr)
                    continue
                chunk.append(custom_id)
                uris.append(uri)
            if not chunk:
                continue
            request = {
                "model": MODEL,
                "encoding_format": "base64",
                "input": [[{"role": "user", "content": [{"type": "image_url", "image_url": {"url": u}}]}] for u in uris],
                "metadata": {"custom_ids": chunk},  # response.data[i] is custom_ids[i]
            }
            if args.embed_dtype == "float16":
                request["embed_dtype"] = "float16"
            requests.append(request)
            ids += chunk
        with log_lock:
            failures += len(group) - len(ids)
        if not requests:
            return
        body = json.dumps({"webhook_id": webhook_id, "requests": requests}).encode()
        try:
            group_id = post_group(body, api_key, salt)
        except Exception as e:
            print(f"FAILED group of {len(ids)} starting {ids[0]}: {e}", file=sys.stderr)
            with log_lock:
                failures += len(ids)
            return
        with log_lock:
            line = json.dumps({"groupId": group_id, "custom_ids": ids, "submitted_at": time.time()})
            log.write(line + "\n")
            log.flush()
            print(line, flush=True)

    started = time.monotonic()
    in_flight = threading.BoundedSemaphore(args.concurrency * 2)  # bounds queued groups (memory)
    with ThreadPoolExecutor(args.concurrency) as pool:
        for group in groups:
            in_flight.acquire()
            pool.submit(submit, group).add_done_callback(lambda _: in_flight.release())
    elapsed = time.monotonic() - started
    print(f"done in {elapsed:.1f}s ({len(todo) / max(elapsed, 1e-9):.0f} images/s), {failures} images not submitted", file=sys.stderr)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
