import { afterEach, describe, expect, it } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import OutboxDeclinedError from "../src/outbox-declined-error";
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
        expect.assertions(4);

        const { enqueued, sink } = recordingSink();
        const client = makeClient(sink, "client-fixed");

        await client.mutation(fnRef("messages:send"), { text: "first" }, { shardKey: "room-1" });
        await client.mutation(fnRef("messages:send"), { text: "second" });

        expect(enqueued).toHaveLength(2);
        expect(enqueued[0]).toStrictEqual({
            args: { text: "first" },
            // Handed to the sink so it can replay the write under the cursor it
            // was composed at. `undefined` here: this client holds no live
            // subscription to take one from.
            baselineSeq: undefined,
            clientId: "client-fixed",
            functionPath: "messages:send",
            idempotencyKey: expect.stringMatching(/^client-fixed:/u),
            identity: null,
            mutationId: 1,
            shardKey: "room-1",
        });
        expect(enqueued[1]).toMatchObject({ idempotencyKey: expect.stringMatching(/^client-fixed:/u), mutationId: 2, shardKey: undefined });
        expect(enqueued[1]?.idempotencyKey).not.toBe(enqueued[0]?.idempotencyKey);
    });

    // A `@lunora/db` app passes a stable `clientId`, so the same id comes back after
    // every reload and in every tab. The server answers a repeated key from its
    // cache for a day: a key that recurs with the id makes a new write a no-op.
    it("gives each outbox write a key no other client instance with the same clientId reuses", async () => {
        expect.assertions(3);

        const first = recordingSink();
        const second = recordingSink();

        await makeClient(first.sink, "client-stable").mutation(fnRef("messages:send"), { text: "before reload" });
        await makeClient(second.sink, "client-stable").mutation(fnRef("messages:send"), { text: "after reload" });

        expect(first.enqueued[0]?.mutationId).toBe(second.enqueued[0]?.mutationId);
        expect(second.enqueued[0]?.idempotencyKey).toMatch(/^client-stable:/u);
        expect(second.enqueued[0]?.idempotencyKey).not.toBe(first.enqueued[0]?.idempotencyKey);
    });

    // An anonymous caller's dedup rows are keyed by client id, and a client built
    // without a stable one mints a new id per session.
    it("sends a durable replay under the client id it was queued with, not its own", async () => {
        expect.assertions(2);

        const clientIds: (string | null)[] = [];
        const client = new LunoraClient({
            clientId: "client-new",
            fetch: async (_input, init) => {
                clientIds.push(new Headers(init?.headers).get("x-lunora-client-id"));

                return Response.json({ result: null });
            },
            offlineQueue: { queueBeforeFirstConnect: true },
            outbox: recordingSink().sink,
            url: "https://app.example",
            WebSocket: seedableWebSocket(),
        });

        client.subscribe(fnRef("nodes:list"), {}, () => {});
        (sockets.at(-1) as SeedableSocket).open();

        await client.mutation(fnRef("messages:send"), { text: "x" }, { mutationId: "client-old:k", replayBaseline: null, replayClientId: "client-old" });
        await client.mutation(fnRef("messages:send"), { text: "y" }, { mutationId: "live" });

        expect(clientIds[0]).toBe("client-old");
        expect(clientIds[1]).toBe("client-new");

        client.close();
    });

    // `@lunora/db`'s sink declines a write it cannot store in this tab (it does
    // not lead the outbox). The write must not be dropped or reported as failed:
    // the client keeps it in its own queue, with its predicted value on screen.
    it("keeps a write the sink declines in the built-in queue, optimistic value and all", async () => {
        expect.assertions(3);

        const declined: OutboxMutation[] = [];
        const client = new LunoraClient({
            offlineQueue: { queueBeforeFirstConnect: true },
            outbox: {
                enqueue: async (mutation) => {
                    declined.push(mutation);

                    throw new OutboxDeclinedError();
                },
            },
            url: "https://app.example",
            WebSocket: seedableWebSocket(),
        });
        const received: unknown[] = [];

        client.subscribe(fnRef("counter:get"), {}, (value) => received.push(value));

        const socket = sockets.at(-1) as SeedableSocket;

        socket.open();
        socket.receive({ delta: 1, id: subscriptionId(socket), type: "delta" });
        socket.triggerClose();

        const inQueue = new Promise<void>((resolve) => {
            client.onPendingChange((count) => {
                if (count > 0) {
                    resolve();
                }
            });
        });
        const queued = client.mutation(fnRef("counter:get"), {}, { optimistic: (current) => (current as number) + 1 });

        queued.catch(() => undefined);
        await inQueue;

        expect(client.pendingCount()).toBe(1);
        expect(declined).toHaveLength(1);
        expect(received).toEqual([1, 2]);

        client.close();
    });

    it("rejects a declined write when the client closed while the sink was deciding", async () => {
        expect.assertions(2);

        let decline: (() => void) | undefined;
        let sinkAsked: () => void = () => {};
        const asked = new Promise<void>((resolve) => {
            sinkAsked = resolve;
        });
        const client = makeClient({
            enqueue: async () =>
                new Promise<void>((_resolve, reject) => {
                    decline = () => {
                        reject(new OutboxDeclinedError());
                    };
                    sinkAsked();
                }),
        });

        const write = client.mutation(fnRef("messages:send"), { text: "x" });
        const queuedAfterClose = new Promise<"queued">((resolve) => {
            client.onPendingChange((count) => {
                if (count > 0) {
                    resolve("queued");
                }
            });
        });

        await asked;
        client.close();
        decline?.();

        const outcome = await Promise.race([
            write.then(
                () => "resolved" as const,
                (error: unknown) => error,
            ),
            queuedAfterClose,
        ]);

        expect(outcome).toBeInstanceOf(Error);
        expect(client.pendingCount()).toBe(0);
    });

    it("sends a write the sink declined behind its backlog when the socket is already open", async () => {
        expect.assertions(2);

        const sent: string[] = [];
        const client = new LunoraClient({
            fetch: async (input) => {
                sent.push(input instanceof Request ? input.url : input.toString());

                return Response.json({ result: "ok" });
            },
            offlineQueue: { queueBeforeFirstConnect: true },
            outbox: {
                enqueue: async () => {
                    throw new OutboxDeclinedError();
                },
                // A backlog this tab cannot drain: a live write goes behind it, to the sink.
                pending: () => true,
            },
            url: "https://app.example",
            WebSocket: seedableWebSocket(),
        });

        client.subscribe(fnRef("nodes:list"), {}, () => {});
        (sockets.at(-1) as SeedableSocket).open();

        const result = await client.mutation(fnRef("messages:send"), { text: "x" });

        expect(result).toBe("ok");
        expect(sent).toHaveLength(1);

        client.close();
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

    it("keeps an importRows chunk's own key in the outbox, and reports it queued rather than imported", async () => {
        expect.assertions(3);

        const { enqueued, sink } = recordingSink();
        let fetches = 0;
        const client = new LunoraClient({
            fetch: async () => {
                fetches += 1;

                return Response.json({ result: null });
            },
            offlineQueue: { queueBeforeFirstConnect: true },
            // Something unrelated is still waiting in the outbox, so every new
            // write goes behind it even though the socket is open.
            outbox: { ...sink, pending: () => true },
            url: "https://app.example",
            WebSocket: seedableWebSocket(),
        });

        client.subscribe(fnRef("nodes:list"), {}, () => {});
        (sockets.at(-1) as SeedableSocket).open();

        const result = await client.importRows(fnRef("nodes:import"), [1, 2, 3], { chunkSize: 1, importId: "imp" });

        expect(enqueued.map((mutation) => mutation.idempotencyKey)).toStrictEqual(["imp:0", "imp:1", "imp:2"]);
        expect(result).toStrictEqual({ chunks: 3, imported: 0, queued: 3 });
        expect(fetches).toBe(0);
    });

    // A durable replay re-enters `mutation` from the outbox it is draining. Queued
    // again while the socket is down, it would be persisted as a new write behind
    // newer ones while the outbox counted the original as done. It must fail with
    // an error the outbox retries — one with no `code` — and leave the original.
    it("refuses a durable replay while the socket is down instead of queueing it again", async () => {
        expect.assertions(4);

        const { enqueued, sink } = recordingSink();
        const client = makeClient(sink, "client-fixed");

        const refused = await client
            .mutation(fnRef("messages:send"), { text: "replay" }, { mutationId: "client-fixed:9", replayBaseline: null })
            .catch((error: unknown) => error);

        expect(refused).toBeInstanceOf(Error);
        expect((refused as { code?: unknown }).code).toBeUndefined();
        expect(enqueued).toHaveLength(0);

        await client.mutation(fnRef("messages:send"), { text: "fresh" }, { mutationId: "client-fixed:10" });

        expect(enqueued.map((mutation) => mutation.idempotencyKey)).toStrictEqual(["client-fixed:10"]);

        client.close();
    });

    it("opens the connection a refused durable replay needs, so the outbox's retry can send it", async () => {
        expect.assertions(2);

        const { sink } = recordingSink();
        const client = new LunoraClient({
            offlineQueue: { queueBeforeFirstConnect: true },
            outbox: sink,
            url: "https://app.example",
            WebSocket: seedableWebSocket(),
        });
        const before = sockets.length;

        // Nothing in this session subscribed to the shard, so no connection is coming for it otherwise.
        const refused = await client
            .mutation(fnRef("messages:send"), { text: "replay" }, { mutationId: "client-x:1", replayBaseline: null })
            .catch((error: unknown) => error);

        expect(refused).toBeInstanceOf(Error);
        expect(sockets).toHaveLength(before + 1);

        client.close();
    });

    it("takes a refused durable replay's optimistic value back off the screen", async () => {
        expect.assertions(2);

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
        socket.triggerClose();

        await client.mutation(fnRef("counter:get"), {}, { optimistic: (current) => (current as number) + 1, replayBaseline: null }).catch(() => undefined);

        expect(received).toEqual([1, 2, 1]);
        expect(enqueued).toHaveLength(0);

        client.close();
    });
});
