"""Transport-level tests for the RPC verbs (`query` / `mutation` / `action`)."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lunora.client import LunoraClient  # noqa: E402


def _record():
    """A fake HTTP transport returning an empty result and capturing every post."""

    calls = []

    def post(url, headers, body):
        calls.append({"body": json.loads(body.decode("utf-8")), "headers": headers, "url": url})
        return 200, {"result": None}

    return calls, post


class TestRpcVerbs(unittest.TestCase):
    def test_action_sends_no_idempotency_key(self):
        calls, post = _record()
        client = LunoraClient("https://app.example", http_post=post)

        asyncio.run(client.action("payments:charge", {"amount": 100}))

        self.assertEqual(calls[-1]["url"], "https://app.example/_lunora/rpc")
        self.assertEqual(calls[-1]["body"]["functionPath"], "payments:charge")
        self.assertEqual(calls[-1]["body"]["args"], {"amount": 100})
        # An action performs external side effects and is not replayed against
        # the shard, so it must not claim mutation-style idempotency.
        self.assertNotIn("x-lunora-mutation-id", calls[-1]["headers"])

    def test_mutation_sends_the_idempotency_key_when_given(self):
        calls, post = _record()
        client = LunoraClient("https://app.example", http_post=post)

        asyncio.run(client.mutation("messages:send", {"text": "hi"}, mutation_id="m1"))

        self.assertEqual(calls[-1]["headers"]["x-lunora-mutation-id"], "m1")

    def test_shard_key_is_omitted_when_absent(self):
        calls, post = _record()
        client = LunoraClient("https://app.example", http_post=post)

        asyncio.run(client.query("messages:list", {"channelId": "c1"}))
        self.assertNotIn("shardKey", calls[-1]["body"])

        asyncio.run(client.query("messages:list", {"channelId": "c1"}, shard_key="tenant_a"))
        self.assertEqual(calls[-1]["body"]["shardKey"], "tenant_a")


if __name__ == "__main__":
    unittest.main()
