import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import type { FunctionReference } from "../src/types";

/**
 * Replies the client cannot read a value out of, although the request itself
 * succeeded: a committed write whose `result` does not decode, a 2xx body that
 * is not an object, and a poke carrying a row the codec refuses.
 *
 * Each used to escape as a raw codec or `TypeError` exception — out of a batch
 * replay (losing every later slot for the session), into an endless retry of a
 * write that had already committed, or out of the socket's message handler
 * after half a poke was buffered, with the checkpoint then advanced past rows
 * the view never held.
 */

const UNDECODABLE = ["$lunora.wire$", "bigint", "not-a-number"];

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

        public constructor() {
            sockets.push(this);
        }

        public addEventListener(type: string, listener: (event?: unknown) => void): void {
            this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
        }

        public open(): void {
            this.readyState = 1;
            this.dispatch("open");
        }

        public receive(payload: unknown): void {
            this.dispatch("message", { data: JSON.stringify(payload) });
        }

        public triggerClose(): void {
            this.readyState = 3;
            this.dispatch("close");
        }

        public send(data: string): void {
            this.sent.push(data);
        }

        public close(): void {
            this.triggerClose();
        }

        private dispatch(type: string, event?: unknown): void {
            for (const listener of this.listeners.get(type) ?? []) {
                listener(event);
            }
        }
    }

    return WS as unknown as typeof WebSocket;
};

const latestSocket = (): MockSocket => {
    const last = sockets.at(-1);

    if (!last) {
        throw new Error("no socket has been created yet");
    }

    return last;
};

const fnRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

const offlineClient = (fetchImpl: typeof fetch): LunoraClient =>
    new LunoraClient({
        fetch: fetchImpl,
        heartbeatIntervalMs: 0,
        reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
        url: "https://app.example",
        WebSocket: createMockWebSocket(),
    });

/** Connect once (so writes queue rather than throw), then drop offline. */
const goOffline = (client: LunoraClient): void => {
    client.subscribe(fnRef("posts:list"), {}, () => undefined);
    latestSocket().open();
    latestSocket().triggerClose();
};

const outcomeOf = (promise: Promise<unknown>): { value?: unknown } => {
    const outcome: { value?: unknown } = {};

    promise
        .then((value) => {
            outcome.value = { committed: value };

            return undefined;
        })
        .catch((error: unknown) => {
            outcome.value = { rejected: (error as { code?: string }).code };
        });

    return outcome;
};

describe("replies the client cannot decode", () => {
    beforeEach(() => {
        sockets.length = 0;
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("settles a batch slot whose committed result does not decode, and every slot after it", async () => {
        expect.assertions(5);

        vi.useFakeTimers();

        const fetchMock = vi.fn<typeof fetch>(async () =>
            Response.json({
                results: [
                    { body: { commitCursor: 3, result: "a" }, id: 0 },
                    { body: { commitCursor: 4, result: UNDECODABLE }, id: 1 },
                    { body: { commitCursor: 5, result: "c" }, id: 2 },
                ],
            }),
        );
        const client = offlineClient(fetchMock);
        const settled: { code?: string; status: string }[] = [];

        client.onMutationSettled((event) => settled.push({ code: event.code, status: event.status }));
        goOffline(client);

        const outcomes = ["a", "b", "c"].map((title) => outcomeOf(client.mutation(fnRef("posts:create"), { title })));

        await vi.advanceTimersByTimeAsync(10);
        latestSocket().open();
        await vi.advanceTimersByTimeAsync(0);

        // ONE request: the undecodable slot neither aborted the demux nor sent a retry.
        expect(fetchMock).toHaveBeenCalledTimes(1);
        // The write committed — its caller learns the value could not be read, and
        // the slots around it settle with their own values.
        expect(outcomes.map((outcome) => outcome.value)).toStrictEqual([{ committed: "a" }, { rejected: "WIRE_DECODE_FAILED" }, { committed: "c" }]);
        expect(settled).toStrictEqual([
            { code: undefined, status: "committed" },
            { code: "WIRE_DECODE_FAILED", status: "committed" },
            { code: undefined, status: "committed" },
        ]);
        expect(client.pendingCount()).toBe(0);

        // A later reconnect replays nothing: nothing was left behind or requeued.
        latestSocket().triggerClose();
        await vi.advanceTimersByTimeAsync(10);
        latestSocket().open();
        await vi.advanceTimersByTimeAsync(0);

        expect(fetchMock).toHaveBeenCalledTimes(1);

        client.close();
    });

    it("settles a lone committed write whose result does not decode instead of replaying it forever", async () => {
        expect.assertions(4);

        vi.useFakeTimers();

        const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ commitCursor: 7, result: UNDECODABLE }));
        const client = offlineClient(fetchMock);
        const settled: { code?: string; status: string }[] = [];

        client.onMutationSettled((event) => settled.push({ code: event.code, status: event.status }));
        goOffline(client);

        const outcome = outcomeOf(client.mutation(fnRef("posts:create"), { title: "lone" }));

        await vi.advanceTimersByTimeAsync(10);
        latestSocket().open();
        await vi.advanceTimersByTimeAsync(0);

        expect(outcome.value).toStrictEqual({ rejected: "WIRE_DECODE_FAILED" });
        expect(settled).toStrictEqual([{ code: "WIRE_DECODE_FAILED", status: "committed" }]);

        // Reconnect again: a write that was classified transient would go out a
        // second time, and a third, for as long as the session lasts.
        latestSocket().triggerClose();
        await vi.advanceTimersByTimeAsync(10);
        latestSocket().open();
        await vi.advanceTimersByTimeAsync(0);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(client.pendingCount()).toBe(0);

        client.close();
    });

    it.each([
        ["null", "null"],
        ["an array", "[]"],
        ["a string", '"ok"'],
        ["a number", "7"],
    ])("fails an RPC whose 2xx body is %s with the client's own error", async (_label, body) => {
        expect.assertions(1);

        const client = new LunoraClient({
            fetch: async () => new Response(body, { headers: { "content-type": "application/json" }, status: 200 }),
            url: "https://app.example",
        });

        await expect(client.query(fnRef("posts:list"), {})).rejects.toMatchObject({ code: "INTERNAL", name: "LunoraError" });

        client.close();
    });

    it("refuses a poke carrying an undecodable row whole, reporting it and keeping the checkpoint", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const client = new LunoraClient({
            heartbeatIntervalMs: 0,
            reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });
        const seen: Record<string, unknown>[][] = [];
        const errors: (string | undefined)[] = [];

        client.subscribeShape({ name: "all" }, (rows) => seen.push(rows), { onError: (error) => errors.push(error.code) });

        const socket = latestSocket();

        socket.open();

        const shapeFrames = (sent: string[]) =>
            sent.map((raw) => JSON.parse(raw) as { id?: string; sinceCheckpoint?: number; type: string }).filter((frame) => frame.type === "shape_subscribe");
        const shapeId = shapeFrames(socket.sent)[0]?.id;

        socket.receive({ epoch: "e1", pokeId: "p1", type: "pokeStart" });
        socket.receive({
            pokeId: "p1",
            rowsPatch: [{ key: "m1", op: "insert", table: "messages", value: { _id: "m1", text: "hi" } }],
            shapeId,
            type: "pokePart",
        });
        socket.receive({ checkpoint: 5, epoch: "e1", pokeId: "p1", type: "pokeEnd" });

        // A reseed whose second row the codec refuses.
        socket.receive({ epoch: "e1", pokeId: "p2", type: "pokeStart" });
        socket.receive({
            pokeId: "p2",
            reset: true,
            rowsPatch: [
                { key: "m3", op: "insert", table: "messages", value: { _id: "m3", text: "fine" } },
                { key: "m4", op: "insert", table: "messages", value: { _id: "m4", n: UNDECODABLE } },
            ],
            shapeId,
            type: "pokePart",
        });
        socket.receive({ checkpoint: 12, epoch: "e1", pokeId: "p2", type: "pokeEnd" });

        // The view is exactly what it was, and the subscriber is told why.
        expect(seen).toStrictEqual([[{ _id: "m1", text: "hi" }]]);
        expect(errors).toStrictEqual(["WIRE_DECODE_FAILED"]);

        // The resume position is still 5, so the server re-sends what the refused
        // poke carried instead of resuming past it.
        socket.triggerClose();
        await vi.advanceTimersByTimeAsync(10);
        latestSocket().open();

        expect(shapeFrames(latestSocket().sent).map((frame) => frame.sinceCheckpoint)).toStrictEqual([5]);

        client.close();
    });

    it("keeps a direct write's optimistic value when it committed but its result does not decode", async () => {
        expect.assertions(2);

        const client = new LunoraClient({
            fetch: async () => Response.json({ commitCursor: 7, result: UNDECODABLE }),
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });
        const received: unknown[] = [];

        client.subscribe(fnRef("c:get"), {}, (value) => received.push(value));
        latestSocket().open();

        const subscribe = latestSocket()
            .sent.map((raw) => JSON.parse(raw) as { id?: string; type: string })
            .find((frame) => frame.type === "subscribe");

        latestSocket().receive({ delta: 0, id: subscribe?.id, type: "delta" });

        await expect(client.mutation(fnRef("c:get"), {}, { optimistic: () => 9 })).rejects.toMatchObject({ code: "WIRE_DECODE_FAILED" });

        // The write committed: its predicted value stays until the confirming
        // frame supersedes it, instead of reverting to the pre-write 0.
        expect(received).toStrictEqual([0, 9]);

        client.close();
    });

    it("keeps a replayed write's optimistic value when it committed but its result does not decode", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const client = offlineClient(async () => Response.json({ commitCursor: 7, result: UNDECODABLE }));
        const received: unknown[] = [];

        client.subscribe(fnRef("c:get"), {}, (value) => received.push(value));
        latestSocket().open();

        const subscribe = latestSocket()
            .sent.map((raw) => JSON.parse(raw) as { id?: string; type: string })
            .find((frame) => frame.type === "subscribe");

        latestSocket().receive({ delta: 0, id: subscribe?.id, type: "delta" });
        latestSocket().triggerClose();

        const outcome = outcomeOf(client.mutation(fnRef("c:get"), {}, { optimistic: () => 9 }));

        await vi.advanceTimersByTimeAsync(10);
        latestSocket().open();
        await vi.advanceTimersByTimeAsync(0);

        expect(outcome.value).toStrictEqual({ rejected: "WIRE_DECODE_FAILED" });
        expect(received.at(-1)).toBe(9);

        client.close();
    });

    it("advances the custom-mutator watermark a reply acknowledged even when its result does not decode", async () => {
        expect.assertions(2);

        const client = new LunoraClient({
            fetch: async () => Response.json({ lastMutationId: 5, result: UNDECODABLE }),
            url: "https://app.example",
        });

        await expect(client.callMutator("messages:send", {}, { clientSeq: 5 })).rejects.toMatchObject({ code: "WIRE_DECODE_FAILED" });

        // The shard applied seq 5; a mutator runtime seeding from a stale
        // watermark would reissue it and have the write swallowed as a replay.
        expect(client.confirmedMutationWatermark()).toBe(5);

        client.close();
    });

    it("raises a coded error whose data does not decode with the data dropped, not the codec's exception", async () => {
        expect.assertions(2);

        const client = new LunoraClient({
            fetch: async () => Response.json({ error: { code: "CONFLICT", data: UNDECODABLE, message: "stale" } }, { status: 409 }),
            url: "https://app.example",
        });

        const failure: { code?: string; data?: unknown; message?: string } = await client.query(fnRef("posts:list"), {}).then(
            () => {
                return {};
            },
            (error_: unknown) => error_ as { code?: string; data?: unknown; message?: string },
        );

        expect(failure).toMatchObject({ code: "CONFLICT", message: "stale" });
        expect(failure.data).toBeUndefined();

        client.close();
    });

    it("classifies a batch slot whose error data does not decode by its code, and settles the slots after it", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const fetchMock = vi.fn<typeof fetch>(async () =>
            Response.json({
                results: [
                    { body: { error: { code: "CONFLICT", data: UNDECODABLE, message: "stale" } }, id: 0 },
                    { body: { commitCursor: 4, result: "b" }, id: 1 },
                ],
            }),
        );
        const client = offlineClient(fetchMock);

        goOffline(client);

        const outcomes = ["a", "b"].map((title) => outcomeOf(client.mutation(fnRef("posts:create"), { title })));

        await vi.advanceTimersByTimeAsync(10);
        latestSocket().open();
        await vi.advanceTimersByTimeAsync(0);

        expect(outcomes.map((outcome) => outcome.value)).toStrictEqual([{ rejected: "CONFLICT" }, { committed: "b" }]);
        expect(client.pendingCount()).toBe(0);

        client.close();
    });
});
