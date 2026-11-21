"""Checks submit.reconcile against an in-memory bucket. Run: python -m unittest discover examples/python"""

import io
import json
import time
import unittest

import submit
from submit import idempotency_key, image_url, reconcile


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


class KeyTest(unittest.TestCase):
    def test_same_body_same_key_and_a_salt_changes_it(self):
        body = b'{"requests": []}'
        self.assertEqual(idempotency_key(body, ""), idempotency_key(body, ""))
        self.assertNotEqual(idempotency_key(body, ""), idempotency_key(body, "reconcile-1"))
        self.assertNotEqual(idempotency_key(body, ""), idempotency_key(body + b" ", ""))
        self.assertRegex(idempotency_key(body, ""), "^[0-9a-f]{64}$")


class ImageUrlTest(unittest.TestCase):
    def test_https_as_is_s3_presigned_only_when_asked(self):
        class Signer:
            def generate_presigned_url(self, op, Params, ExpiresIn):
                return f"https://{Params['Bucket']}.s3.amazonaws.com/{Params['Key']}?X-Amz-Expires={ExpiresIn}"

        submit._s3.client = Signer()
        self.assertEqual(image_url("https://cdn.example.com/a.jpg", 0), "https://cdn.example.com/a.jpg")
        self.assertEqual(image_url("s3://b/cats/1.jpg", 259200), "https://b.s3.amazonaws.com/cats/1.jpg?X-Amz-Expires=259200")


if __name__ == "__main__":
    unittest.main()
