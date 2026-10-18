import { describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import type { FunctionReference, OutboxMutation, OutboxSink } from "../src/types";

/**
 * `mutation(…, { onlineOnly: true })` with a durable `outbox` configured. The
 * outbox takes the place of the built-in queue, so an online-only write must
 * stay out of it too: refused while the connection is down, and sent live — not
 * parked behind the sink's backlog — while it is up. A normal write in the same
 * states still reaches the sink, which guards against an over-broad gate.
 */

const fnRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

const settle = async (): Promise<void> => {
    for (let index = 0; index < 8; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- intentional sequential drain of promise ticks
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
    }
};

interface MockSocket {
    open: () => void;
    triggerClose: () => void;
}

const createMockWebSocket = (sockets: MockSocket[]): typeof WebSocket => {
    class WS {
        public readyState = 0;

        private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

        public constructor() {
            sockets.push({
                open: () => {
                    this.readyState = 1;
                    this.emit("open");
                },
                triggerClose: () => {
                    this.readyState = 3;
                    this.emit("close");
                },
            });
        }

        public addEventListener(type: string, listener: (event?: unknown) => void): void {
            const existing = this.listeners.get(type) ?? [];

            existing.push(listener);
            this.listeners.set(type, existing);
        }

        public close(): void {
            this.readyState = 3;
        }

        public removeEventListener(type: string): void {
            this.listeners.delete(type);
        }

        // eslint-disable-next-line class-methods-use-this -- stub WebSocket: writes under test ride HTTP.
        public send(): void {
            /* no-op */
        }

        private emit(type: string): void {
            for (const listener of this.listeners.get(type) ?? []) {
                listener();
            }
        }
    }

    return WS as unknown as typeof WebSocket;
};

const createOutbox = (backlog: boolean): { enqueued: OutboxMutation[]; sink: OutboxSink } => {
    const enqueued: OutboxMutation[] = [];

    return {
        enqueued,
        sink: {
            enqueue: async (mutation) => {
                enqueued.push(mutation);
            },
            pending: () => backlog,
        },
    };
};

const createClient = (outbox: OutboxSink, sockets: MockSocket[]): { client: LunoraClient; fetchSpy: ReturnType<typeof vi.fn<() => Promise<Response>>> } => {
    const fetchSpy = vi.fn<() => Promise<Response>>(async () => Response.json({ result: { ok: true } }, { status: 200 }));
    const client = new LunoraClient({
        fetch: fetchSpy,
        heartbeatIntervalMs: 0,
        outbox,
        url: "http://app.test",
        WebSocket: createMockWebSocket(sockets),
    });

    return { client, fetchSpy };
};

const connect = async (client: LunoraClient, sockets: MockSocket[]): Promise<void> => {
    client.subscribe(fnRef("todos.list"), {}, () => {});
    sockets.at(-1)?.open();
    await settle();
};

describe("online-only mutation with a durable outbox", () => {
    it("is refused while disconnected and never handed to the outbox", async () => {
        expect.hasAssertions();

        const sockets: MockSocket[] = [];
        const { enqueued, sink } = createOutbox(false);
        const { client, fetchSpy } = createClient(sink, sockets);

        await connect(client, sockets);
        sockets.at(-1)?.triggerClose();
        await settle();

        await expect(client.mutation(fnRef("todos.set"), { text: "KEY" }, { onlineOnly: true })).rejects.toMatchObject({ code: "OFFLINE_NOT_QUEUED" });

        expect(enqueued).toStrictEqual([]);
        expect(fetchSpy).not.toHaveBeenCalled();

        client.close();
    });

    it("goes out live while the outbox holds a backlog, where a normal write is parked in it", async () => {
        expect.hasAssertions();

        const sockets: MockSocket[] = [];
        const { enqueued, sink } = createOutbox(true);
        const { client, fetchSpy } = createClient(sink, sockets);

        await connect(client, sockets);

        await expect(client.mutation(fnRef("todos.set"), { text: "KEY" }, { onlineOnly: true })).resolves.toStrictEqual({ ok: true });

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(enqueued).toStrictEqual([]);

        await client.mutation(fnRef("todos.set"), { text: "NORMAL" });

        expect(enqueued).toHaveLength(1);

        client.close();
    });

    it("leaves a normal write disconnected on the outbox path", async () => {
        expect.hasAssertions();

        const sockets: MockSocket[] = [];
        const { enqueued, sink } = createOutbox(false);
        const { client } = createClient(sink, sockets);

        await connect(client, sockets);
        sockets.at(-1)?.triggerClose();
        await settle();

        await client.mutation(fnRef("todos.set"), { text: "NORMAL" });

        expect(enqueued).toHaveLength(1);

        client.close();
    });
});
