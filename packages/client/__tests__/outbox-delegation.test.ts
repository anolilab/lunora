import { afterEach, describe, expect, it } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import type { FunctionReference, OutboxMutation, OutboxSink } from "../src/types";

/**
 * Phase 5 — the durable-outbox seam. When a `LunoraClient` is given an `outbox`
 * sink, offline writes must be delegated to it (the one durable path a
 * `@lunora/db` app gets) and the built-in `OfflineQueue` bypassed entirely.
 * These tests drive the offline branch with no socket and assert the sink
 * receives a fully-stamped {@link OutboxMutation}.
 */

/** A minimal `WebSocket` impl so `shouldQueueOffline` is satisfied; it never opens. */
const inertWebSocket = (): typeof WebSocket => {
    class WS {
        public readonly url: string;

        public readyState = 0;

        public onopen: ((event?: unknown) => void) | null = null;

        public onmessage: ((event: { data: unknown }) => void) | null = null;

        public onclose: ((event?: unknown) => void) | null = null;

        public onerror: ((event?: unknown) => void) | null = null;

        public constructor(url: string) {
            this.url = url;
        }

        // eslint-disable-next-line class-methods-use-this -- stub WebSocket: deliberately inert, no instance state.
        public addEventListener(): void {
            /* never opens — the write stays offline */
        }

        // eslint-disable-next-line class-methods-use-this -- stub WebSocket: deliberately inert, no instance state.
        public close(): void {
            /* no-op */
        }

        // eslint-disable-next-line class-methods-use-this -- stub WebSocket: deliberately inert, no instance state.
        public send(): void {
            /* no-op */
        }
    }

    return WS as unknown as typeof WebSocket;
};

/**
 * The same stub, plus the three hooks a test needs to seed a subscription with a
 * server value before taking the socket away: `open`, `receive` and
 * `triggerClose`. Instances land in `sockets` so the test can reach the live one.
 */
const sockets: SeedableSocket[] = [];

interface SeedableSocket {
    open: () => void;
    receive: (payload: unknown) => void;
    sent: string[];
    triggerClose: () => void;
}

const seedableWebSocket = (): typeof WebSocket => {
    class WS {
        public readonly url: string;

        public readyState = 0;

        public sent: string[] = [];

        public onopen: ((event?: unknown) => void) | null = null;

        public onmessage: ((event: { data: unknown }) => void) | null = null;

        public onclose: ((event?: unknown) => void) | null = null;

        public onerror: ((event?: unknown) => void) | null = null;

        private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

        public constructor(url: string) {
            this.url = url;
            sockets.push(this);
        }

        public addEventListener(type: string, listener: (event?: unknown) => void): void {
            const existing = this.listeners.get(type) ?? [];

            existing.push(listener);
            this.listeners.set(type, existing);
        }

        public open(): void {
            this.readyState = 1;
            this.onopen?.();
            this.dispatch("open");
        }

        public receive(payload: unknown): void {
            const data = JSON.stringify(payload);

            this.onmessage?.({ data });
            this.dispatch("message", { data });
        }

        public triggerClose(): void {
            this.readyState = 3;
            this.onclose?.();
            this.dispatch("close");
        }

        public send(data: string): void {
            this.sent.push(data);
        }

        public close(): void {
            this.readyState = 3;
        }

        private dispatch(type: string, event?: unknown): void {
            for (const listener of this.listeners.get(type) ?? []) {
                listener(event);
            }
        }
    }

    return WS as unknown as typeof WebSocket;
};

/** The id of the `subscribe` frame the socket sent, so a `delta` can be addressed to it. */
const subscriptionId = (socket: SeedableSocket): string =>
    socket.sent
        .filter((frame) => frame !== "lunora-ping")
        .map((frame) => JSON.parse(frame) as { id?: string; type: string })
        .find((frame) => frame.type === "subscribe")?.id ?? "";

const fnRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

/** A sink that records every enqueued mutation; `overflow` makes `enqueue` reject. */
const recordingSink = (overflow = false): { enqueued: OutboxMutation[]; sink: OutboxSink } => {
    const enqueued: OutboxMutation[] = [];

    return {
        enqueued,
        sink: {
            enqueue: (mutation) => {
                enqueued.push(mutation);

                if (overflow) {
                    const error = new Error("cap exceeded") as Error & { code?: string };

                    error.code = "OFFLINE_QUEUE_OVERFLOW";

                    return Promise.reject(error);
                }

                return Promise.resolve();
            },
        },
    };
};

const makeClient = (sink: OutboxSink, clientId?: string): LunoraClient =>
    new LunoraClient({
        clientId,
        offlineQueue: { queueBeforeFirstConnect: true },
        outbox: sink,
        url: "https://app.example",
        WebSocket: inertWebSocket(),
    });

describe("lunoraClient outbox delegation", () => {
    afterEach(() => {
        /* each test builds its own client; nothing global to reset */
    });

    it("delegates an offline write to the outbox sink, stamped with clientId + monotonic mutationId", async () => {
        expect.assertions(3);

        const { enqueued, sink } = recordingSink();
        const client = makeClient(sink, "client-fixed");

        await client.mutation(fnRef("messages:send"), { text: "first" }, { shardKey: "room-1" });
        await client.mutation(fnRef("messages:send"), { text: "second" });

        expect(enqueued).toHaveLength(2);
        expect(enqueued[0]).toStrictEqual({
            args: { text: "first" },
            clientId: "client-fixed",
            functionPath: "messages:send",
            idempotencyKey: "client-fixed:1",
            identity: null,
            mutationId: 1,
            shardKey: "room-1",
        });
        // Monotonic per-client mutation id, and the idempotency key pairs it with clientId.
        expect(enqueued[1]).toMatchObject({ idempotencyKey: "client-fixed:2", mutationId: 2, shardKey: undefined });
    });

    it("surfaces an overflow rejection to the caller instead of swallowing it", async () => {
        expect.assertions(1);

        const { sink } = recordingSink(true);
        const client = makeClient(sink, "client-fixed");

        await expect(client.mutation(fnRef("messages:send"), { text: "x" })).rejects.toMatchObject({ code: "OFFLINE_QUEUE_OVERFLOW" });
    });

    it("hands the sink an onRejected that takes a permanently rejected write's optimistic value off the screen", async () => {
        expect.assertions(3);

        const { enqueued, sink } = recordingSink();
        const client = new LunoraClient({
            offlineQueue: { queueBeforeFirstConnect: true },
            outbox: sink,
            url: "https://app.example",
            WebSocket: seedableWebSocket(),
        });

        const received: unknown[] = [];

        client.subscribe(fnRef("counter:get"), {}, (value) => received.push(value));

        const socket = sockets.at(-1) as SeedableSocket;

        socket.open();
        socket.receive({ delta: 1, id: subscriptionId(socket), type: "delta" });
        // Offline again: the write is durably queued instead of sent.
        socket.triggerClose();

        await client.mutation(fnRef("counter:get"), {}, { optimistic: (current) => (current as number) + 1 });

        // Predicted value stays on screen while the write waits in the outbox.
        expect(received).toEqual([1, 2]);

        // The sink's owner (`@lunora/db`'s replay handler) reaches a permanent
        // verdict out of band; this handle is the client's only way to hear it.
        enqueued[0]?.onRejected?.();

        expect(received).toEqual([1, 2, 1]);

        // Idempotent: a sink that calls it twice doesn't re-notify.
        enqueued[0]?.onRejected?.();

        expect(received).toEqual([1, 2, 1]);
    });
});
