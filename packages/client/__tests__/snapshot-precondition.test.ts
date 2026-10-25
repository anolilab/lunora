/* eslint-disable no-secrets/no-secrets -- the flagged strings are the `peekActiveQuerySnapshot` method name, not credentials */
import { afterEach, describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import createSnapshotPrecondition from "../src/snapshot-precondition";
import type { FunctionReference } from "../src/types";

/**
 * `createSnapshotPrecondition` is the staleness guard that decides whether a queued
 * offline mutation is dropped on replay: it snapshots a live query's value at call
 * time and, on replay, re-reads it via {@link LunoraClient.peekActiveQuerySnapshot} to
 * decide whether it still matches. The comparison only runs when a live subscription
 * backed BOTH reads — an unobserved query (no subscription) is treated as not-stale
 * rather than as a value that appeared or disappeared. These tests cover that branch
 * directly against that one-method stub seam.
 */

const fnRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

type Snapshot = { answered: boolean; present: boolean; value: unknown };

/** Stub exposing only `peekActiveQuerySnapshot` — the one client method this module calls. */
const stubClient = (snapshot: Snapshot, current: Snapshot): LunoraClient => {
    const peekActiveQuerySnapshot = vi.fn<LunoraClient["peekActiveQuerySnapshot"]>().mockReturnValueOnce(snapshot).mockReturnValueOnce(current);

    return { peekActiveQuerySnapshot } as unknown as LunoraClient;
};

describe("createSnapshotPrecondition", () => {
    it("no subscription at either read -> true (nothing to compare)", () => {
        expect.assertions(1);

        const client = stubClient({ answered: false, present: false, value: undefined }, { answered: false, present: false, value: undefined });
        const precondition = createSnapshotPrecondition(client, fnRef("todos:list"), {});

        expect(precondition()).toBe(true);
    });

    it("subscription live at snapshot, absent at replay -> true (unmounted, not a conflict)", () => {
        expect.assertions(1);

        const client = stubClient({ answered: true, present: true, value: { id: 1 } }, { answered: false, present: false, value: undefined });
        const precondition = createSnapshotPrecondition(client, fnRef("todos:list"), {});

        expect(precondition()).toBe(true);
    });

    it("subscription absent at snapshot, live at replay -> true", () => {
        expect.assertions(1);

        const client = stubClient({ answered: false, present: false, value: undefined }, { answered: true, present: true, value: { id: 1 } });
        const precondition = createSnapshotPrecondition(client, fnRef("todos:list"), {});

        expect(precondition()).toBe(true);
    });

    it("both live, value changed -> false", () => {
        expect.assertions(1);

        const client = stubClient(
            { answered: true, present: true, value: { id: 1, text: "a" } },
            { answered: true, present: true, value: { id: 1, text: "b" } },
        );
        const precondition = createSnapshotPrecondition(client, fnRef("todos:list"), {});

        expect(precondition()).toBe(false);
    });

    it("both live, current subscription blanked and unanswered -> true (no evidence)", () => {
        expect.assertions(1);

        const client = stubClient({ answered: true, present: true, value: { id: 1 } }, { answered: false, present: true, value: undefined });
        const precondition = createSnapshotPrecondition(client, fnRef("todos:list"), {});

        expect(precondition()).toBe(true);
    });

    it("both live, value unchanged -> true", () => {
        expect.assertions(1);

        const client = stubClient(
            { answered: true, present: true, value: { id: 1, text: "a" } },
            { answered: true, present: true, value: { id: 1, text: "a" } },
        );
        const precondition = createSnapshotPrecondition(client, fnRef("todos:list"), {});

        expect(precondition()).toBe(true);
    });

    it("both live, value genuinely became undefined while subscribed -> false (still a conflict)", () => {
        expect.assertions(1);

        const client = stubClient({ answered: true, present: true, value: { id: 1 } }, { answered: true, present: true, value: undefined });
        const precondition = createSnapshotPrecondition(client, fnRef("todos:list"), {});

        expect(precondition()).toBe(false);
    });
});

/**
 * `client.snapshotPrecondition(...)` is the documented ergonomic entry point —
 * it is what the module function's own example tells users to call. It must
 * therefore answer identically; a second hand-written copy of the comparison
 * behind it is how the "unmounted component drops the queued write" bug
 * survived the module-level fix.
 */
describe("lunoraClient.snapshotPrecondition", () => {
    /** A real `LunoraClient` prototype method bound to a stub with only the peek it uses. */
    const boundMethod = (snapshot: Snapshot, current: Snapshot): (() => boolean) => {
        const client = stubClient(snapshot, current);

        return LunoraClient.prototype.snapshotPrecondition.call(client, fnRef("todos:list"), {});
    };

    it("subscription live at snapshot, absent at replay -> true (the originating component unmounted)", () => {
        expect.assertions(1);

        expect(boundMethod({ answered: true, present: true, value: { id: 1 } }, { answered: false, present: false, value: undefined })()).toBe(true);
    });

    it("subscription absent at snapshot, live at replay -> true", () => {
        expect.assertions(1);

        expect(boundMethod({ answered: false, present: false, value: undefined }, { answered: true, present: true, value: { id: 1 } })()).toBe(true);
    });

    it("both live, value changed -> false", () => {
        expect.assertions(1);

        expect(
            boundMethod({ answered: true, present: true, value: { id: 1, text: "a" } }, { answered: true, present: true, value: { id: 1, text: "b" } })(),
        ).toBe(false);
    });

    it("both live, value unchanged -> true", () => {
        expect.assertions(1);

        expect(
            boundMethod({ answered: true, present: true, value: { id: 1, text: "a" } }, { answered: true, present: true, value: { id: 1, text: "a" } })(),
        ).toBe(true);
    });
});

/**
 * A bearer sign-in on a transport that presents it on the upgrade reconnects every socket cold, which blanks each
 * subscription's value until the new socket answers. The offline queue replays on that socket's `open`, before
 * the answers land, so a blank must read as "no evidence", not as a changed value.
 */
describe("snapshotPrecondition across a cold reconnect", () => {
    interface Frames {
        close: () => void;
        open: () => void;
        receive: (payload: unknown) => void;
        sent: Record<string, unknown>[];
    }

    const sockets: Frames[] = [];

    class MockSocket {
        public readyState = 0;

        private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

        private readonly sent: Record<string, unknown>[] = [];

        public constructor(public readonly url: string) {
            sockets.push({
                close: () => {
                    this.close();
                },
                open: () => {
                    this.readyState = 1;
                    this.emit("open");
                },
                receive: (payload) => {
                    this.emit("message", { data: JSON.stringify(payload) });
                },
                sent: this.sent,
            });
        }

        public addEventListener(type: string, listener: (event?: unknown) => void): void {
            this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
        }

        public close(): void {
            this.readyState = 3;
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

    it("treats a subscription blanked by the reconnect as undecided, not as a changed value", () => {
        expect.assertions(2);

        sockets.length = 0;

        const client = new LunoraClient({
            authTokenOnUpgrade: true,
            fetch: vi.fn<typeof fetch>(async () => Response.json({}, { status: 200 })),
            heartbeatIntervalMs: 0,
            persistence: false,
            url: "http://app.test",
            WebSocket: MockSocket as unknown as typeof WebSocket,
        });

        client.subscribe(fnRef("todos.list"), {}, () => {});

        const socket = sockets.at(-1);

        socket?.open();
        socket?.receive({ cursor: 1, data: [{ _id: "t1" }], id: socket.sent.find((message) => message.type === "subscribe")?.id, type: "data" });

        const precondition = client.snapshotPrecondition(fnRef("todos.list"), {});

        expect(precondition()).toBe(true);

        client.setAuthToken("tok-a", "user-a");

        expect(precondition()).toBe(true);

        client.close();
    });

    /**
     * The offline queue replays on a socket's `open`, before any resubscribe is answered, and the server acks a
     * `subscribe` before it seeds it. A write guarded by a snapshot of a still-mounted query must wait for that seed:
     * judged earlier, it compares against a blank (cold) or the previous socket's value (warm), and replays a write
     * whose data changed while it was queued.
     */
    describe("a queued write guarded by a snapshot", () => {
        const subscribeId = (socket: Frames | undefined): unknown => socket?.sent.find((message) => message.type === "subscribe")?.id;
        const isRpc = ([input]: Parameters<typeof fetch>): boolean => !String(input instanceof Request ? input.url : input).includes("get-session");

        /** A client with one answered `todos.list` subscription, a captured snapshot of it, and the RPC calls it makes. */
        const answeredClient = () => {
            vi.useFakeTimers();
            sockets.length = 0;

            const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ result: { ok: true } }, { status: 200 }));
            const client = new LunoraClient({
                authTokenOnUpgrade: true,
                fetch: fetchMock,
                heartbeatIntervalMs: 0,
                persistence: false,
                reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
                url: "http://app.test",
                WebSocket: MockSocket as unknown as typeof WebSocket,
            });
            const unsubscribe = client.subscribe(fnRef("todos.list"), {}, () => {});
            const first = sockets.at(-1);

            first?.open();
            first?.receive({ type: "ack", id: subscribeId(first) });
            first?.receive({ cursor: 1, data: [{ _id: "t1" }], id: subscribeId(first), type: "data" });

            const precondition = client.snapshotPrecondition(fnRef("todos.list"), {});
            const rpcCalls = (): number => fetchMock.mock.calls.filter((call) => isRpc(call)).length;

            return { client, precondition, rpcCalls, unsubscribe };
        };

        const queueWrite = (client: LunoraClient, precondition: () => boolean): Promise<unknown> =>
            client.mutation(fnRef("todos.set"), { text: "a" }, { precondition }).then(
                () => "sent",
                (error: unknown) => (error as { code?: string }).code,
            );

        afterEach(() => {
            vi.useRealTimers();
        });

        it("drops it when the seed after a cold reconnect differs, even after the subscribe was acked", async () => {
            expect.assertions(3);

            const { client, precondition, rpcCalls } = answeredClient();

            // A bearer sign-in on this transport reconnects cold: the value is blanked until the new socket seeds it.
            client.setAuthToken("tok-a", "user-a");

            const outcome = queueWrite(client, precondition);
            const reconnected = sockets.at(-1);

            reconnected?.open();
            await vi.advanceTimersByTimeAsync(0);
            reconnected?.receive({ type: "ack", id: subscribeId(reconnected) });
            await vi.advanceTimersByTimeAsync(0);

            expect(rpcCalls()).toBe(0);

            reconnected?.receive({ cursor: 2, data: [{ _id: "t1" }, { _id: "t2" }], id: subscribeId(reconnected), type: "data" });

            await expect(outcome).resolves.toBe("OFFLINE_PRECONDITION_FAILED");

            expect(rpcCalls()).toBe(0);

            client.close();
        });

        it("sends it once the seed after a cold reconnect matches the snapshot, not on the ack before it", async () => {
            expect.assertions(2);

            const { client, precondition, rpcCalls } = answeredClient();

            client.setAuthToken("tok-a", "user-a");

            const outcome = queueWrite(client, precondition);
            const reconnected = sockets.at(-1);

            reconnected?.open();
            await vi.advanceTimersByTimeAsync(0);
            // Judged here, the acked blank would read as a changed value and drop the write.
            reconnected?.receive({ type: "ack", id: subscribeId(reconnected) });
            await vi.advanceTimersByTimeAsync(0);

            expect(rpcCalls()).toBe(0);

            reconnected?.receive({ cursor: 2, data: [{ _id: "t1" }], id: subscribeId(reconnected), type: "data" });

            await expect(outcome).resolves.toBe("sent");

            client.close();
        });

        it("keeps it held, unjudged, while another query on the shard is answered first", async () => {
            expect.assertions(2);

            const { client, precondition, rpcCalls } = answeredClient();

            client.subscribe(fnRef("todos.count"), {}, () => {});
            client.setAuthToken("tok-a", "user-a");

            const outcome = queueWrite(client, precondition);
            const reconnected = sockets.at(-1);
            const idOf = (path: string): unknown =>
                reconnected?.sent.find((message) => message.type === "subscribe" && (message.query as { functionPath?: string }).functionPath === path)?.id;

            reconnected?.open();
            await vi.advanceTimersByTimeAsync(0);
            reconnected?.receive({ type: "ack", id: idOf("todos.list") });
            // This answer re-runs the flush while the guarded query sits acked and blank.
            reconnected?.receive({ cursor: 2, data: 1, id: idOf("todos.count"), type: "data" });
            await vi.advanceTimersByTimeAsync(0);

            expect(rpcCalls()).toBe(0);

            reconnected?.receive({ cursor: 2, data: [{ _id: "t1" }], id: idOf("todos.list"), type: "data" });

            await expect(outcome).resolves.toBe("sent");

            client.close();
        });

        it("sends it when the seed after a cold reconnect is refused, rather than reading the acked blank as a change", async () => {
            expect.assertions(1);

            const { client, precondition } = answeredClient();

            client.setAuthToken("tok-a", "user-a");

            const outcome = queueWrite(client, precondition);
            const reconnected = sockets.at(-1);

            reconnected?.open();
            await vi.advanceTimersByTimeAsync(0);
            reconnected?.receive({ type: "ack", id: subscribeId(reconnected) });
            reconnected?.receive({
                code: "SUBSCRIPTION_SEED_FAILED",
                error: { code: "SUBSCRIPTION_SEED_FAILED", message: "subscription seed failed" },
                id: subscribeId(reconnected),
                type: "error",
            });

            await expect(outcome).resolves.toBe("sent");

            client.close();
        });

        it("waits on a warm reconnect for the resume rather than judging the previous socket's value", async () => {
            expect.assertions(2);

            const { client, precondition, rpcCalls } = answeredClient();

            sockets.at(-1)?.close();

            const outcome = queueWrite(client, precondition);

            await vi.advanceTimersByTimeAsync(10);

            const reconnected = sockets.at(-1);

            reconnected?.open();
            await vi.advanceTimersByTimeAsync(0);

            expect(rpcCalls()).toBe(0);

            reconnected?.receive({ cursor: 1, id: subscribeId(reconnected), type: "resume" });

            await expect(outcome).resolves.toBe("sent");

            client.close();
        });

        it("sends it when the guarded query unmounts before it is answered", async () => {
            expect.assertions(2);

            const { client, precondition, rpcCalls, unsubscribe } = answeredClient();

            sockets.at(-1)?.close();

            const outcome = queueWrite(client, precondition);

            await vi.advanceTimersByTimeAsync(10);
            sockets.at(-1)?.open();
            await vi.advanceTimersByTimeAsync(0);

            expect(rpcCalls()).toBe(0);

            unsubscribe();

            await expect(outcome).resolves.toBe("sent");

            client.close();
        });
    });
});
