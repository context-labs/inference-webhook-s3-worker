"""Checks submit.reconcile against an in-memory bucket. Run: python -m unittest discover examples/python"""

import io
import json
import time
import unittest

from submit import reconcile


class FakeS3:
    """The two boto3 S3 client calls reconcile makes, over a dict of key -> body."""

    def __init__(self, objects: dict[str, bytes]):
        self.objects, self.gets = objects, []

    def get_paginator(self, _name):
        return self

    def paginate(self, Bucket, Prefix):
        yield {"Contents": [{"Key": key} for key in sorted(self.objects) if key.startswith(Prefix)]}

    def get_object(self, Bucket, Key):
        self.gets.append(Key)
        return {"Body": io.BytesIO(self.objects[Key])}


def group(*requests: tuple[str, list[str]]) -> bytes:
    gens = [{"state": state, "request": {"metadata": {"custom_ids": ids}}} for state, ids in requests]
    return json.dumps({"data": {"generations": gens}}).encode()


class ReconcileTest(unittest.TestCase):
    def test_lists_groups_and_reads_only_marked_ones(self):
        old, new = time.time() - 48 * 3600, time.time()
        entries = [
            {"groupId": "saved", "custom_ids": ["a", "b"], "submitted_at": old},
            {"groupId": "partial", "custom_ids": ["c", "d"], "submitted_at": old},
            {"groupId": "lost", "custom_ids": ["e"], "submitted_at": old},
            {"groupId": "running", "custom_ids": ["f"], "submitted_at": new},
        ]
        s3 = FakeS3({
            "emb/groups/saved.json": group(("Success", ["a", "b"])),
            "emb/groups/partial.json": group(("Success", ["c"]), ("Failed", ["d"])),
            "emb/failures/groups/partial.json": b"{}",
            "emb/groups/not-logged.json": group(("Success", ["z"])),
        })
        self.assertEqual(reconcile(entries, s3, "s3://bucket/emb/", 24, False), {"a", "b", "c", "f"})
        self.assertEqual(s3.gets, ["emb/groups/partial.json"])

    def test_get_all_reads_groups_without_markers(self):
        entries = [{"groupId": "legacy", "custom_ids": ["a", "b"], "submitted_at": 0}]
        s3 = FakeS3({"groups/legacy.json": group(("Success", ["a"]), ("Failed", ["b"]))})
        self.assertEqual(reconcile(entries, s3, "s3://bucket", 24, False), {"a", "b"})
        self.assertEqual(reconcile(entries, s3, "s3://bucket", 24, True), {"a"})


if __name__ == "__main__":
    unittest.main()
