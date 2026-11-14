"""The release a watch owns: closing it must unsubscribe even when the loop never ran."""

import asyncio
import unittest

from lunora.client import LunoraClient


class WatchLifecycleTest(unittest.TestCase):
    def test_closing_a_watch_that_was_never_iterated_unsubscribes(self):
        frames: list = []

        async def scenario() -> None:
            client = LunoraClient("https://app.example")
            client.attach_socket(frames.append)

            values = client.watch("messages:list", {"channel": "general"})

            await values.aclose()

        asyncio.run(scenario())

        unsubscribes = [frame["id"] for frame in frames if frame.get("type") == "unsubscribe"]

        self.assertEqual(unsubscribes, ["sub_1"])

    def test_closing_a_watch_twice_unsubscribes_once(self):
        frames: list = []

        async def scenario() -> None:
            client = LunoraClient("https://app.example")
            client.attach_socket(frames.append)

            values = client.watch("messages:list", {})

            try:
                client.handle_frame({"cursor": 1, "data": {"n": 1}, "id": "sub_1", "type": "data"})
                await values.__anext__()
            finally:
                await values.aclose()

            await values.aclose()

        asyncio.run(scenario())

        unsubscribes = [frame["id"] for frame in frames if frame.get("type") == "unsubscribe"]

        self.assertEqual(unsubscribes, ["sub_1"])


if __name__ == "__main__":
    unittest.main()
