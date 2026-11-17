import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { LIVE_CONTROL_PATH, LIVE_PUBLISH_PATH } from "../../../../shared/live-stream";

/**
 * A live topic on a promoted shard (plan 075). The WebSocket lives on a relay DO, while the live
 * grant control call and the live publish both reach the owner. The owner forwards a grant it does
 * not hold to the relay that holds the socket, and forwards a published frame to the relays so
 * their WebSocket members receive it. Without that, the grant returns 404 and the publish never
 * reaches the relay socket.
 */

const BINDING = "SHARD";
const STREAM = "feed";
const TOPIC = "t";

interface OpenSocket {
    frames: { connectionId?: string; data?: unknown; topic?: string; type: string }[];
    ws: WebSocket;
}

const sleep = async (ms: number): Promise<void> => {
    await new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
};

const open = async (stub: DurableObjectStub, room: string): Promise<OpenSocket> => {
    const upgrade = await stub.fetch(`https://${room}.internal/_ws`, { headers: { Upgrade: "websocket", "x-lunora-shard-binding": BINDING } });

    if (!upgrade.webSocket) {
        throw new Error(`expected ws upgrade, got ${String(upgrade.status)}`);
    }

    const ws = upgrade.webSocket;
    const frames: OpenSocket["frames"] = [];

    ws.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
            frames.push(JSON.parse(event.data) as OpenSocket["frames"][number]);
        }
    });
    ws.accept();

    return { frames, ws };
};

describe("relay live topics (workerd e2e)", () => {
    it("applies a grant on the relay holding the socket on the first call, and delivers a publish there", async () => {
        expect.assertions(5);

        const owner = env.SHARD.get(env.SHARD.idFromName("room-live"));
        const relay = env.SHARD.get(env.SHARD.idFromName("room-live::relay::0"));
        const r1 = await open(relay, "room-live-relay-0");

        // Only `connect` is sent before the grant. The client learns the connection id from the
        // identity frame and may subscribe at once, so the relay must already be known to the owner.
        r1.ws.send(JSON.stringify({ type: "connect" }));

        let identity: OpenSocket["frames"][number] | undefined;

        for (let attempt = 0; identity === undefined && attempt < 100; attempt += 1) {
            // eslint-disable-next-line no-await-in-loop -- polling loop must wait between checks
            await sleep(15);
            identity = r1.frames.find((frame) => frame.type === "identity");
        }

        const connectionId = identity?.connectionId ?? "";

        const control = (body: Record<string, unknown>): Promise<Response> =>
            owner.fetch(`https://room-live.internal${LIVE_CONTROL_PATH}`, {
                body: JSON.stringify({ action: "subscribe", connectionId, stream: STREAM, subscriptionId: "sub-1", topic: TOPIC, ...body }),
                headers: { "content-type": "application/json", "x-lunora-shard-binding": BINDING },
                method: "POST",
            });

        // The first grant must land: a 404 here is the reported failure, so no retry.
        const granted = await control({});

        expect(granted.status).toBe(200);
        await expect(granted.json()).resolves.toStrictEqual({ ok: true });

        // A connection id no DO holds is still refused, the relay fan-out does not change that.
        const unknown = await control({ connectionId: "no-such-connection" });

        expect(unknown.status).toBe(404);

        // A live frame reaches a socket only once it is also a member of the topic's whisper channel.
        // That join is asynchronous, so publish until the relay socket receives the frame.
        r1.ws.send(JSON.stringify({ topic: TOPIC, type: "whisper_subscribe" }));

        const liveFrames = (): OpenSocket["frames"] => r1.frames.filter((frame) => frame.type === "live");

        for (let attempt = 0; liveFrames().length === 0 && attempt < 120; attempt += 1) {
            // eslint-disable-next-line no-await-in-loop -- each publish follows the previous wait
            await owner.fetch(`https://room-live.internal${LIVE_PUBLISH_PATH}`, {
                body: JSON.stringify({ data: { n: 1 }, stream: STREAM, topic: TOPIC }),
                headers: { "content-type": "application/json", "x-lunora-shard-binding": BINDING },
                method: "POST",
            });
            // eslint-disable-next-line no-await-in-loop -- polling loop must wait between checks
            await sleep(15);
        }

        // A retried publish can land twice before the first frame is read, so assert delivery, not an exact count.
        expect(liveFrames().length).toBeGreaterThanOrEqual(1);
        expect(liveFrames()[0]?.data).toStrictEqual({ n: 1 });
    });
});
