import { env, evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * A `defineWebSocket` route's frames reach its handler after the shard restarts.
 *
 * The route's socket is accepted with a `socketPath` attachment. `evictDurableObject`
 * tears the shard down, so the next frame is delivered to a fresh instance that only
 * knows the route from that attachment. The handler must still run on real workerd
 * hibernation, which the mocked-socket unit tests cannot show.
 */

describe("defineWebSocket route wake-up (workerd)", () => {
    it("runs the route handler for a frame sent after the shard was evicted", async () => {
        expect.assertions(3);

        const stub = env.SYNC.get(env.SYNC.idFromName("socket-route-wake"));
        const upgrade = await stub.fetch("https://socket-route-wake.internal/chat-wake", { headers: { Upgrade: "websocket" } });

        expect(upgrade.webSocket).not.toBeNull();

        upgrade.webSocket?.accept();

        await evictDurableObject(stub);

        upgrade.webSocket?.send(JSON.stringify({ text: "after wake" }));

        let calls: string[] = [];

        for (let index = 0; index < 200 && calls.length === 0; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- polling loop must wait between reads
            calls = await stub.wakeCalls();

            if (calls.length === 0) {
                // eslint-disable-next-line no-await-in-loop -- polling loop must wait between reads
                await new Promise((resolve) => {
                    setTimeout(resolve, 10);
                });
            }
        }

        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain("after wake");
    });
});
