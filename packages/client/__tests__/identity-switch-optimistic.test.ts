import { describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import type { FunctionReference } from "../src/types";

/**
 * An account switch on one client (sign-out, then a different sign-in, no page
 * reload) must not show the incoming user anything the outgoing one produced.
 * The server values are blanked on the switch; these cover the optimistic
 * layers a still-pending write of the outgoing user left on the subscription,
 * which a blanked base was otherwise folded through straight back on screen.
 */

const fnRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

interface MockSocket {
    closed: boolean;
    open: () => void;
    receive: (payload: unknown) => void;
    sent: Record<string, unknown>[];
}

const sockets: MockSocket[] = [];

const createMockWebSocket = (): typeof WebSocket => {
    class WS {
        public readonly url: string;

        public readyState = 0;

        private readonly sent: Record<string, unknown>[] = [];

        private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

        private readonly record: MockSocket;

        public constructor(url: string) {
            this.url = url;
            this.record = {
                closed: false,
                open: () => {
                    this.readyState = 1;
                    this.emit("open");
                },
                receive: (payload: unknown) => {
                    this.emit("message", { data: JSON.stringify(payload) });
                },
                sent: this.sent,
            };
            sockets.push(this.record);
        }

        public addEventListener(type: string, listener: (event?: unknown) => void): void {
            const existing = this.listeners.get(type) ?? [];

            existing.push(listener);
            this.listeners.set(type, existing);
        }

        public close(): void {
            this.readyState = 3;
            this.record.closed = true;
            this.emit("close", { code: 1000 });
        }

        public removeEventListener(type: string): void {
            this.listeners.delete(type);
        }

        public send(raw: string): void {
            this.sent.push(JSON.parse(raw) as Record<string, unknown>);
        }

        private emit(type: string, event?: unknown): void {
            for (const listener of this.listeners.get(type) ?? []) {
                listener(event);
            }
        }
    }

    return WS as unknown as typeof WebSocket;
};

/** A mutation endpoint that never answers, so the outgoing user's write stays pending across the switch. */
const pendingMutationFetch = (): ReturnType<typeof vi.fn<typeof fetch>> =>
    vi.fn<typeof fetch>(
        async () =>
            await new Promise<Response>(() => {
                /* never settles */
            }),
    );

const signedInWithRow = (): { client: LunoraClient; seen: unknown[]; socket: MockSocket | undefined } => {
    sockets.length = 0;

    const client = new LunoraClient({
        fetch: pendingMutationFetch(),
        heartbeatIntervalMs: 0,
        persistence: false,
        url: "http://app.test",
        WebSocket: createMockWebSocket(),
    });

    client.setAuthToken("tok-a", "user-a");

    const seen: unknown[] = [];

    client.subscribe(fnRef("messages.list"), { channelId: "c1" }, (value) => seen.push(value), { shardKey: "c1" });

    const socket = sockets.at(-1);

    socket?.open();

    const subscribeId = socket?.sent.find((message) => message.type === "subscribe")?.id;

    socket?.receive({ cursor: 4, data: ["A: private"], id: subscribeId, type: "data" });

    return { client, seen, socket };
};

describe("an account switch and the outgoing user's pending optimistic writes", () => {
    it("does not show the previous user's pending optimistic message to the user who signs in next", () => {
        expect.hasAssertions();

        const { client, seen, socket } = signedInWithRow();

        // A's send never answers, so its optimistic layer is still pending at the switch.
        client
            .mutation(
                fnRef("messages.send"),
                { channelId: "c1", text: "A: draft" },
                {
                    optimisticUpdate: (store) => {
                        store.setQuery(fnRef("messages.list"), { channelId: "c1" }, ["A: private", "A: draft"]);
                    },
                    shardKey: "c1",
                },
            )
            .catch(() => undefined);

        expect(seen.at(-1)).toStrictEqual(["A: private", "A: draft"]);

        client.setAuthToken("tok-b", "user-b");

        expect(socket?.closed).toBe(true);
        expect(seen.at(-1)).toBeUndefined();

        let replayed: unknown = "not-called";

        client.subscribe(
            fnRef("messages.list"),
            { channelId: "c1" },
            (value) => {
                replayed = value;
            },
            { shardKey: "c1" },
        );

        expect(replayed).toBe("not-called");

        client.close();
    });

    it("refuses the rest of an optimistic update once a subscriber switches users partway through it", () => {
        expect.hasAssertions();

        const { client, socket } = signedInWithRow();
        const counts: unknown[] = [];

        client.subscribe(fnRef("messages.count"), { channelId: "c1" }, (value) => counts.push(value), { shardKey: "c1" });

        const countId = socket?.sent.findLast((message) => message.type === "subscribe")?.id;

        socket?.receive({ cursor: 4, data: 1, id: countId, type: "data" });

        // Notified synchronously by the first setQuery, before the second one runs.
        client.subscribe(
            fnRef("messages.list"),
            { channelId: "c1" },
            (value) => {
                if (Array.isArray(value) && value.includes("A: draft")) {
                    client.setAuthToken("tok-b", "user-b");
                }
            },
            { shardKey: "c1" },
        );

        client
            .mutation(
                fnRef("messages.send"),
                { channelId: "c1", text: "A: draft" },
                {
                    optimisticUpdate: (store) => {
                        store.setQuery(fnRef("messages.list"), { channelId: "c1" }, ["A: private", "A: draft"]);
                        store.setQuery(fnRef("messages.count"), { channelId: "c1" }, 2);
                    },
                    shardKey: "c1",
                },
            )
            .catch(() => undefined);

        expect(socket?.closed).toBe(true);
        expect(counts).toStrictEqual([1, undefined]);

        client.close();
    });
});
