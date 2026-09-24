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

/** The request URL of a `fetch` call, whichever of the three input shapes it used. */
const urlOf = (input: RequestInfo | URL): string => {
    if (typeof input === "string") {
        return input;
    }

    return input instanceof URL ? input.href : input.url;
};

/** The `x-lunora-base-seq` header of the nth `POST /_lunora/rpc` call, or `undefined`. */
const baseSeqOf = (fetchMock: ReturnType<typeof vi.fn>, index: number): string | undefined => {
    const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;

    return (init?.headers as Record<string, string> | undefined)?.["x-lunora-base-seq"];
};

/**
 * The per-entry `baselineSeq` values of the nth `POST /_lunora/rpc-batch` body,
 * in wire order.
 *
 * The baseline rides each ENTRY, not the outer request: a batch carries writes
 * composed at different cursors, so one outbound header cannot state a baseline
 * for all of them.
 */
const batchBaselinesOf = (fetchMock: ReturnType<typeof vi.fn>, index: number): (number | undefined)[] => {
    const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;
    const body = JSON.parse(init?.body as string) as { calls: { baselineSeq?: number }[] };

    return body.calls.map((call) => call.baselineSeq);
};

/** The `/_lunora/rpc-batch` fetch calls, in order. */
const batchCallIndexes = (fetchMock: ReturnType<typeof vi.fn>): number[] =>
    fetchMock.mock.calls.flatMap((call, index) => (urlOf(call[0] as RequestInfo | URL).endsWith("/_lunora/rpc-batch") ? [index] : []));

/**
 * The `x-lunora-base-seq` of the single-call `/rpc` request that carried the
 * write titled `title`.
 *
 * Found by BODY, not by array position: nothing ties `mock.calls.at(-1)` to a
 * particular write, so a future retry/poll/bookmark refresh landing in the same
 * window would silently move the index and the assertion would read the wrong
 * request.
 */
const baseSeqOfWrite = (fetchMock: ReturnType<typeof vi.fn>, title: string): string | undefined => {
    for (const [index, call] of fetchMock.mock.calls.entries()) {
        const init = call[1] as RequestInit | undefined;

        if (typeof init?.body !== "string") {
            continue;
        }

        const body = JSON.parse(init.body) as { args?: { title?: string } };

        if (body.args?.title === title) {
            return baseSeqOf(fetchMock, index);
        }
    }

    throw new Error(`no /rpc call carried a write titled "${title}"`);
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

    // `0` is a real cursor — "this client had seen nothing" — and is exactly the
    // baseline that should make every field look changed. The DO layer pins the
    // same case; this guards the client hop, where a truthiness check would drop
    // it and send no header at all, which the shard reads as "apply unchanged".
    it("sends a zero baseline rather than treating it as absent", async () => {
        expect.assertions(1);

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: null }));
        const client = new LunoraClient({ fetch: fetchMock, url: "https://app.example", WebSocket: createMockWebSocket() });

        await client.mutation(fnRef("documents:rename"), { title: "zero" }, { replayBaseline: 0 });

        expect(baseSeqOfWrite(fetchMock, "zero")).toBe("0");

        client.close();
    });

    // `null` pins "composed with no baseline"; omitting the option samples the
    // current cursor instead. Collapsing the two is the clobber this guards.
    it("pins `no baseline` on null, and samples on undefined", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: null }));
        const client = new LunoraClient({ fetch: fetchMock, url: "https://app.example", WebSocket: createMockWebSocket() });

        client.subscribe(fnRef("documents:list"), {}, () => {});

        const socket = sockets[0];

        socket?.open();
        socket?.receive({ cursor: 42, data: [], id: subscribeId(socket), type: "data" });

        await client.mutation(fnRef("documents:rename"), { title: "pinned" }, { replayBaseline: null });
        await client.mutation(fnRef("documents:rename"), { title: "sampled" });

        expect(baseSeqOfWrite(fetchMock, "pinned")).toBeUndefined();
        expect(baseSeqOfWrite(fetchMock, "sampled")).toBe("42");

        client.close();
    });

    // The replay path is chosen by COUNT: one queued write rides the single-call
    // path, two or more coalesce into `/_lunora/rpc-batch`. The batch entries
    // carried no baseline at all, so the protection a multi-edit offline session
    // most needs was the one case that silently lost it — while the single-write
    // test above stayed green.
    it("carries each write's own baseline through a BATCHED replay", async () => {
        expect.assertions(3);

        const fetchMock = vi.fn<typeof fetch>(async (input) =>
            urlOf(input).endsWith("/_lunora/rpc-batch")
                ? jsonResponse({
                      results: [
                          { body: { result: null }, id: 0 },
                          { body: { result: null }, id: 1 },
                      ],
                  })
                : jsonResponse({ result: null }),
        );
        const client = new LunoraClient({
            fetch: fetchMock,
            persistence: createInMemoryPersistence(),
            reconnect: { initialDelayMs: 1, jitter: false, maxDelayMs: 1 },
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });

        client.subscribe(fnRef("documents:list"), {}, () => {});

        const socket = sockets[0];

        socket?.open();

        const id = subscribeId(socket!);

        socket?.receive({ cursor: 10, data: [], id, type: "data" });
        socket?.triggerClose();

        // TWO writes, so the flush takes the batch path. Both are composed while
        // offline at cursor 10.
        const first = client.mutation(fnRef("documents:rename"), { title: "one" });
        const second = client.mutation(fnRef("documents:rename"), { title: "two" });

        await flushMicrotasks();

        expect(fetchMock).not.toHaveBeenCalled();

        await settle();

        const reconnected = sockets.at(-1);

        reconnected?.open();

        const resumedId = subscribeId(reconnected!);

        // Catch up well past the composed cursor BEFORE the queue drains.
        reconnected?.receive({ cursor: 99, data: [], id: resumedId, type: "data" });

        await settle();
        await Promise.allSettled([first, second]);

        const batches = batchCallIndexes(fetchMock);

        expect(batches).toHaveLength(1);
        expect(batchBaselinesOf(fetchMock, batches[0]!)).toStrictEqual([10, 10]);

        client.close();
    });

    // `mutation()` awaits an in-flight flush for the shard before deciding how to
    // send. Sampling the baseline after that wait reads the cursor frames advanced
    // to DURING it, so the write claims its author saw changes that landed after
    // they composed it.
    it("samples the baseline at the call, not after the in-flight-flush barrier", async () => {
        expect.assertions(1);

        // Only the FIRST request parks — that is the in-flight flush the next
        // call has to wait behind. Everything after it answers immediately, or
        // the write under test would park on its own request and never settle.
        let releaseFlush: (() => void) | undefined;
        let parked = false;
        const fetchMock = vi.fn<typeof fetch>(async () => {
            if (parked) {
                return jsonResponse({ result: null });
            }

            parked = true;

            return await new Promise<Response>((resolve) => {
                releaseFlush = () => {
                    resolve(jsonResponse({ result: null }));
                };
            });
        });
        const client = new LunoraClient({
            fetch: fetchMock,
            persistence: createInMemoryPersistence(),
            reconnect: { initialDelayMs: 1, jitter: false, maxDelayMs: 1 },
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });

        client.subscribe(fnRef("documents:list"), {}, () => {});

        const socket = sockets[0];

        socket?.open();

        const id = subscribeId(socket!);

        socket?.receive({ cursor: 10, data: [], id, type: "data" });

        // Queue a write, then reconnect so its replay is in flight and parked on
        // the fetch above — this is the `offlineFlushes` entry the next call awaits.
        socket?.triggerClose();

        const queued = client.mutation(fnRef("documents:rename"), { title: "queued" });

        await flushMicrotasks();
        await settle();

        const reconnected = sockets.at(-1);

        reconnected?.open();

        const resumedId = subscribeId(reconnected!);

        reconnected?.receive({ cursor: 10, data: [], id: resumedId, type: "data" });
        await settle();

        // Composed NOW, against cursor 10 — but it parks on the barrier.
        const behindBarrier = client.mutation(fnRef("documents:rename"), { title: "behind" });

        await flushMicrotasks();

        // Frames land while it waits. A baseline read after the wait would say 99.
        reconnected?.receive({ cursor: 99, data: [], id: resumedId, type: "data" });

        releaseFlush?.();

        await settle();
        await Promise.allSettled([queued, behindBarrier]);

        expect(baseSeqOfWrite(fetchMock, "behind")).toBe("10");

        client.close();
    });
});
