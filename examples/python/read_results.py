"""Read embeddings from stored group objects (groups/<groupId>.json).

Usage:
  python read_results.py groups/abc.json ...                 # local files
  python read_results.py s3://my-bucket/embeddings/groups/abc.json ...  # needs boto3

As a library:
  for custom_id, vec in iter_group(load("groups/abc.json")):
      ...  # vec is a 1-D np.float32 array, also for embed_dtype "float16"

Requires: pip install -r requirements.txt (boto3 only for s3:// paths).
"""

import base64
import json
import sys
from collections.abc import Iterator

import numpy as np

def load(path: str) -> dict:
    """Load one group object from a local path or an s3://bucket/key URL."""
    if path.startswith("s3://"):
        import boto3  # only needed for S3 paths

        bucket, key = path[5:].split("/", 1)
        body = boto3.client("s3").get_object(Bucket=bucket, Key=key)["Body"].read()
        return json.loads(body)
    with open(path, "rb") as f:
        return json.load(f)


def decode(embedding: str | list[float], embed_dtype: str = "float32") -> np.ndarray:
    """base64 = little-endian float32 bytes, or float16 with embed_dtype "float16" (returned
    as float32); a list = encoding_format "float"."""
    if isinstance(embedding, str):
        vec = np.frombuffer(base64.b64decode(embedding), dtype="<f2" if embed_dtype == "float16" else "<f4")
        vec = vec.astype(np.float32)
    else:
        vec = np.asarray(embedding, dtype=np.float32)
    if vec.ndim != 1 or vec.size == 0:
        raise ValueError(f"bad embedding shape {vec.shape}")
    return vec


def iter_group(doc: dict, failed: list[str] | None = None) -> Iterator[tuple[str, np.ndarray]]:
    """Yield (custom_id, vector) for every image in a group.

    Each generation is one request. Its own request.metadata.custom_ids maps
    response.data[i] (by .index) to an id. Generations are NOT in submission
    order, so never map by position across generations.
    Custom ids of failed requests are appended to `failed`: resubmit those.
    The request is stored with each generation, so its embed_dtype says how to decode.
    """
    for gen in doc["data"]["generations"]:
        ids = gen["request"]["metadata"]["custom_ids"]
        embed_dtype = gen["request"].get("embed_dtype", "float32")
        if gen["state"] != "Success":
            if failed is not None:
                failed.extend(ids)
            continue
        data = gen["response"]["data"]
        if len(data) != len(ids):
            raise ValueError(f"generation {gen['id']}: {len(data)} vectors for {len(ids)} ids")
        for item in data:
            yield ids[item["index"]], decode(item["embedding"], embed_dtype)


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    total, failed = 0, []
    for path in sys.argv[1:]:
        for custom_id, vec in iter_group(load(path), failed):
            norm = float(np.linalg.norm(vec))
            if abs(norm - 1) > 1e-3:
                print(f"WARNING {custom_id}: norm {norm:.5f}", file=sys.stderr)
            total += 1
    print(f"{total} vectors OK, {len(failed)} failed ids to resubmit")
    for custom_id in failed:
        print(f"FAILED {custom_id}", file=sys.stderr)


if __name__ == "__main__":
    main()
