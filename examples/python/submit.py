"""Submit images to inference.net async image embeddings, in groups.

Each group = up to 10 requests x 50 images = 500 images, one webhook, one S3 object.
Every submitted group is printed and appended to a JSONL log; rerunning with the same log
skips images that are already submitted, so an interrupted run resumes.

Usage (Python 3.10+, stdlib only):
  export INFERENCE_API_KEY=... INFERENCE_WEBHOOK_ID=... INFERENCE_MODEL=...
  python submit.py ./images                   # every .jpg/.jpeg/.png/.webp under a folder; id = relative path
  python submit.py manifest.csv               # CSV with header "id,path"; path may be s3://bucket/key (needs boto3)
  python submit.py manifest.csv --rate 2000 --concurrency 16 --log submitted.jsonl

Exit code 1 if any group or image failed; rerun the same command to retry only those.
"""

import argparse
import base64
import csv
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


def read_image(path: str) -> bytes:
    """S3 HOOK: replace or extend this to read from your own storage."""
    if path.startswith("s3://"):
        if not hasattr(_s3, "client"):
            import boto3  # pip install boto3; one client per thread

            _s3.client = boto3.client("s3")
        bucket, key = path[5:].split("/", 1)
        return _s3.client.get_object(Bucket=bucket, Key=key)["Body"].read()
    return Path(path).read_bytes()


def data_uri(path: str) -> str:
    mime = MIME.get(Path(path).suffix.lower(), "jpeg")
    return f"data:image/{mime};base64,{base64.b64encode(read_image(path)).decode()}"


def post_group(body: bytes, api_key: str) -> str:
    """POST one group; retry 429/5xx/network errors with backoff + jitter. Returns groupId.

    Not idempotent: if a POST times out after the server accepted it, the retry
    creates a second group with the same images. Key results by custom_id.
    """
    for attempt in range(1, MAX_ATTEMPTS + 1):
        req = urllib.request.Request(API_URL, data=body, method="POST", headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "embeddings-submit/1.0",  # some default user agents (e.g. Python urllib) get 403
        })
        retry_after = None
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.load(resp)["groupId"]
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:500]
            if e.code != 429 and e.code < 500:
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
    args = ap.parse_args()
    api_key, webhook_id = os.environ["INFERENCE_API_KEY"], os.environ["INFERENCE_WEBHOOK_ID"]

    done: set[str] = set()
    if os.path.exists(args.log):
        with open(args.log) as f:
            for line in f:
                done.update(json.loads(line)["custom_ids"])
    # ponytail: the whole manifest and resume set live in memory; shard
    # billion-image manifests into files of a few million rows, one process each.
    todo = [item for item in list_images(args.source) if item[0] not in done]
    per_group = args.images_per_request * args.requests_per_group
    groups = [todo[i : i + per_group] for i in range(0, len(todo), per_group)]
    print(f"{len(done)} already submitted, {len(todo)} to go in {len(groups)} groups", file=sys.stderr)

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
                    uri = data_uri(path)
                except Exception as e:  # unreadable file or object: report, keep going
                    print(f"SKIP {custom_id}: {e}", file=sys.stderr)
                    continue
                if len(uri) > MAX_DATA_URI_CHARS:
                    print(f"SKIP {custom_id}: {len(uri)} chars > {MAX_DATA_URI_CHARS}; downscale it", file=sys.stderr)
                    continue
                chunk.append(custom_id)
                uris.append(uri)
            if not chunk:
                continue
            requests.append({
                "model": MODEL,
                "encoding_format": "base64",
                "input": [[{"role": "user", "content": [{"type": "image_url", "image_url": {"url": u}}]}] for u in uris],
                "metadata": {"custom_ids": chunk},  # response.data[i] is custom_ids[i]
            })
            ids += chunk
        with log_lock:
            failures += len(group) - len(ids)
        if not requests:
            return
        body = json.dumps({"webhook_id": webhook_id, "requests": requests}).encode()
        try:
            group_id = post_group(body, api_key)
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
