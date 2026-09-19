import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import { createInMemoryPersistence } from "../src/persistence";
import type { FunctionReference } from "../src/types";

/**
 * The client half of `.dropStalePatches()`: the CDC baseline a write is composed
 * against, stamped at CALL time and replayed verbatim.
 *
 * The verbatim part is the whole feature. Re-deriving a baseline at replay time
 * would hand the shard the cursor the client has ADVANCED to while the write sat
 * in the queue — the newer state the write is supposed to be judged against — so
 * every stale write would look fresh and clobber exactly as before.
 */

const flushMicrotasks = (): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, 0);
    });

/** Real-time wait, long enough for the (deliberately tiny) reconnect backoff below to fire. */
const settle = (ms = 25): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

interface MockSocket {
    open: () => void;
    receive: (payload: unknown) => void;
    sent: string[];
    triggerClose: () => void;
}

const sockets: MockSocket[] = [];

const createMockWebSocket = (): typeof WebSocket => {
    class WS {
        public readyState = 0;

        public sent: string[] = [];

        private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

        public constructor(public readonly url: string) {
            sockets.push(this);
        }

        public addEventListener(type: string, listener: (event?: unknown) => void): void {
            this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
        }

        public close(): void {
            this.readyState = 3;
        }

        public open(): void {
            this.readyState = 1;
            this.dispatch("open");
        }

        public receive(payload: unknown): void {
            this.dispatch("message", { data: typeof payload === "string" ? payload : JSON.stringify(payload) });
        }

        public send(data: string): void {
            this.sent.push(data);
        }

        public triggerClose(): void {
            this.readyState = 3;
            this.dispatch("close");
        }

        private dispatch(type: string, event?: unknown): void {
            for (const listener of this.listeners.get(type) ?? []) {
                listener(event);
            }
        }
    }

    return WS as unknown as typeof WebSocket;
};

const fnRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

const jsonResponse = (body: unknown): Response => Response.json(body, { headers: { "content-type": "application/json" }, status: 200 });

/** The `x-lunora-base-seq` header of the nth `POST /_lunora/rpc` call, or `undefined`. */
const baseSeqOf = (fetchMock: ReturnType<typeof vi.fn>, index: number): string | undefined => {
    const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;

    return (init?.headers as Record<string, string> | undefined)?.["x-lunora-base-seq"];
};

/** The subscribe frame's id, so a test can push a cursor-stamped data frame back. */
const subscribeId = (socket: MockSocket): string => {
    for (const raw of socket.sent) {
        const frame = JSON.parse(raw) as { id?: string; type?: string };

        if (frame.type === "subscribe" && frame.id !== undefined) {
            return frame.id;
        }
    }

    throw new Error("no subscribe frame was sent");
};

describe("lunoraClient CDC baseline", () => {
    beforeEach(() => {
        sockets.length = 0;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("sends no baseline before any subscription has a cursor", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: null }));
        const client = new LunoraClient({ fetch: fetchMock, url: "https://app.example", WebSocket: createMockWebSocket() });

        await client.mutation(fnRef("documents:rename"), { title: "x" });

        // Honest absence, not `0`: a `0` baseline would claim the client had seen
        // NOTHING, making every field look changed and discarding every patch.
        expect(baseSeqOf(fetchMock, 0)).toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(1);

        client.close();
    });

    it("stamps the highest cursor its live queries have reached", async () => {
        expect.assertions(1);

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: null }));
        const client = new LunoraClient({ fetch: fetchMock, url: "https://app.example", WebSocket: createMockWebSocket() });

        client.subscribe(fnRef("documents:list"), {}, () => {});

        const socket = sockets[0];

        socket?.open();

        const id = subscribeId(socket!);

        socket?.receive({ cursor: 41, data: [], id, type: "data" });
        socket?.receive({ cursor: 57, data: [], id, type: "data" });

        await client.mutation(fnRef("documents:rename"), { title: "x" });

        expect(baseSeqOf(fetchMock, 0)).toBe("57");

        client.close();
    });

    it("replays a queued write under the cursor it was COMPOSED at, not the current one", async () => {
        expect.assertions(3);

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: null }));
        const client = new LunoraClient({
            fetch: fetchMock,
            persistence: createInMemoryPersistence(),
            // A tiny, jitter-free backoff so the reconnect below lands inside the
            // test's real-time wait instead of its default quarter-second.
            reconnect: { initialDelayMs: 1, jitter: false, maxDelayMs: 1 },
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });

        client.subscribe(fnRef("documents:list"), {}, () => {});

        const socket = sockets[0];

        socket?.open();

        const id = subscribeId(socket!);

        socket?.receive({ cursor: 10, data: [], id, type: "data" });

        // Go offline and compose a write against cursor 10.
        socket?.triggerClose();

        const queued = client.mutation(fnRef("documents:rename"), { title: "mine" });

        await flushMicrotasks();

        expect(fetchMock).not.toHaveBeenCalled();

        // Reconnect. The client catches up to a much newer cursor BEFORE the queue
        // drains — the exact window that makes re-deriving the baseline wrong.
        await settle();

        const reconnected = sockets.at(-1);

        reconnected?.open();

        const resumedId = subscribeId(reconnected!);

        reconnected?.receive({ cursor: 99, data: [], id: resumedId, type: "data" });

        await settle();
        await queued;

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(baseSeqOf(fetchMock, 0)).toBe("10");

        client.close();
    });
});
