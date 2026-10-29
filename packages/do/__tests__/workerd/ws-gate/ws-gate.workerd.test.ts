/**
 * Real-workerd coverage of the `LUNORA_WS_BEARER` gate on a shard socket.
 *
 * The mock suite drives a fake socket. These upgrade through the runtime, so the
 * acceptance, the attachment serialization, and the close delivery are workerd's own.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// The gate's bearer, fixed in this project's vitest config.
const BEARER = "ws-gate-workerd-fixture";

interface GatedSocket {
    client: WebSocket;
    /** Resolves with the close code: the milestone a refused socket reaches. */
    closed: Promise<number>;
    /** The close code once it has arrived, or `undefined` while the socket is open. */
    closedCode: () => number | undefined;
    /** Resolves once the server sends its `identity` frame: the milestone an admitted socket reaches. */
    identity: Promise<void>;
    received: string[];
}

// A fresh shard per test, so no test sees another's sockets.
const newStub = () => env.SHARD.get(env.SHARD.idFromName(`gate-${crypto.randomUUID()}`));

const upgrade = async (stub: ReturnType<typeof newStub>): Promise<GatedSocket> => {
    const response = await stub.fetch("https://shard.internal/_ws", { headers: { Upgrade: "websocket" } });

    if (!response.webSocket) {
        throw new Error(`expected websocket upgrade, got status ${String(response.status)}`);
    }

    const client = response.webSocket;
    const received: string[] = [];
    let code: number | undefined;

    const identity = new Promise<void>((resolve) => {
        client.addEventListener("message", (event) => {
            if (typeof event.data === "string") {
                received.push(event.data);

                if (event.data.includes('"type":"identity"')) {
                    resolve();
                }
            }
        });
    });
    const closed = new Promise<number>((resolve) => {
        client.addEventListener("close", (event) => {
            code = event.code;
            resolve(event.code);
        });
    });

    client.accept();

    return { client, closed, closedCode: () => code, identity, received };
};

describe("shardDO bearer gate (workerd)", () => {
    it("holds an unauthenticated upgrade until connect, then admits it on the matching bearer", async () => {
        expect.assertions(3);

        const stub = newStub();
        const socket = await upgrade(stub);

        socket.client.send(JSON.stringify({ id: "connect", token: BEARER, type: "connect" }));
        await socket.identity;

        expect(socket.closedCode()).toBeUndefined();

        // The admitted flag is what the runtime serialized, so it survives hibernation.
        await runInDurableObject(stub, (_instance, state) => {
            const [ws] = state.getWebSockets();
            const attachment = ws?.deserializeAttachment() as { authenticated?: boolean };

            expect(attachment.authenticated).toBe(true);
        });

        expect(socket.received.some((message) => message.includes('"type":"identity"'))).toBe(true);

        socket.client.close(1000, "bye");
    });

    it("closes a gated socket whose connect carries the wrong bearer, and admits nothing", async () => {
        expect.assertions(2);

        const socket = await upgrade(newStub());

        socket.client.send(JSON.stringify({ id: "connect", token: "not-the-bearer", type: "connect" }));

        await expect(socket.closed).resolves.toBe(4003);
        expect(socket.received.some((message) => message.includes('"type":"identity"'))).toBe(false);
    });

    it("refuses a subscribe sent before any connect frame, with the UNAUTHENTICATED error", async () => {
        expect.assertions(2);

        const socket = await upgrade(newStub());

        socket.client.send(JSON.stringify({ id: "s", query: { args: {}, functionPath: "messages:list" }, type: "subscribe" }));

        await expect(socket.closed).resolves.toBe(4003);
        expect(socket.received.some((message) => message.includes('"code":"UNAUTHENTICATED"'))).toBe(true);
    });
});
