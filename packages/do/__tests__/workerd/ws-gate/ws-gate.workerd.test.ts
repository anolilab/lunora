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
    closed: number | undefined;
    received: string[];
}

const waitFor = async (predicate: () => boolean, { intervalMs = 10, timeoutMs = 2000 }: { intervalMs?: number; timeoutMs?: number } = {}): Promise<void> => {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (predicate()) {
            return;
        }

        // eslint-disable-next-line no-await-in-loop -- polling a socket milestone is the point: each check waits on the runtime's queue
        await new Promise((resolve) => {
            setTimeout(resolve, intervalMs);
        });
    }

    throw new Error(`waitFor: predicate never became true within ${String(timeoutMs)}ms`);
};

// A fresh shard per test, so no test sees another's sockets.
const newStub = () => env.SHARD.get(env.SHARD.idFromName(`gate-${crypto.randomUUID()}`));

const upgrade = async (stub: ReturnType<typeof newStub>): Promise<GatedSocket> => {
    const response = await stub.fetch("https://shard.internal/_ws", { headers: { Upgrade: "websocket" } });

    if (!response.webSocket) {
        throw new Error(`expected websocket upgrade, got status ${String(response.status)}`);
    }

    const socket: GatedSocket = { client: response.webSocket, closed: undefined, received: [] };

    socket.client.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
            socket.received.push(event.data);
        }
    });
    socket.client.addEventListener("close", (event) => {
        socket.closed = event.code;
    });
    socket.client.accept();

    return socket;
};

describe("shardDO bearer gate (workerd)", () => {
    it("holds an unauthenticated upgrade until connect, then admits it on the matching bearer", async () => {
        expect.assertions(3);

        const stub = newStub();
        const socket = await upgrade(stub);

        socket.client.send(JSON.stringify({ id: "connect", token: BEARER, type: "connect" }));
        await waitFor(() => socket.received.some((message) => message.includes('"type":"identity"')));

        expect(socket.closed).toBeUndefined();

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
        await waitFor(() => socket.closed !== undefined);

        expect(socket.closed).toBe(4003);
        expect(socket.received.some((message) => message.includes('"type":"identity"'))).toBe(false);
    });

    it("refuses a subscribe sent before any connect frame, with the UNAUTHENTICATED error", async () => {
        expect.assertions(2);

        const socket = await upgrade(newStub());

        socket.client.send(JSON.stringify({ id: "s", query: { args: {}, functionPath: "messages:list" }, type: "subscribe" }));
        await waitFor(() => socket.closed !== undefined);

        expect(socket.closed).toBe(4003);
        expect(socket.received.some((message) => message.includes('"code":"UNAUTHENTICATED"'))).toBe(true);
    });
});
