import { afterEach, describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import { createInMemoryPersistence } from "../src/persistence";
import type { QueryCacheAdapter } from "../src/types";
import { createSocketHarness, fnRef, jsonResponse, settle } from "./lib/harness";

/** A `fetch` that never answers, recording the signal it was given. */
const hangingFetch = () => {
    const signals: (AbortSignal | undefined | null)[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
        signals.push(init?.signal);

        return new Promise<Response>(() => {
            /* never answers */
        });
    });

    return { fetchImpl, signals };
};

const abortName = async (promise: Promise<unknown>): Promise<string | undefined> => {
    try {
        await promise;

        return undefined;
    } catch (error) {
        return (error as { name?: string }).name;
    }
};

describe("abort signal", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("cancels an in-flight query and its request", async () => {
        expect.assertions(2);

        const { fetchImpl, signals } = hangingFetch();
        const client = new LunoraClient({ fetch: fetchImpl, url: "http://app.test" });
        const controller = new AbortController();
        const outcome = abortName(client.query(fnRef("todos.list"), {}, { signal: controller.signal }));

        await Promise.resolve();
        controller.abort();

        await expect(outcome).resolves.toBe("AbortError");
        expect(signals[0]?.aborted).toBe(true);

        client.close();
    });

    it("cancels an in-flight action and its request", async () => {
        expect.assertions(2);

        const { fetchImpl, signals } = hangingFetch();
        const client = new LunoraClient({ fetch: fetchImpl, url: "http://app.test" });
        const controller = new AbortController();
        const outcome = abortName(client.action(fnRef("ai.run"), {}, { signal: controller.signal }));

        await Promise.resolve();
        controller.abort();

        await expect(outcome).resolves.toBe("AbortError");
        expect(signals[0]?.aborted).toBe(true);

        client.close();
    });

    it("sends nothing for a mutation whose signal is already aborted", async () => {
        expect.assertions(2);

        const { fetchImpl } = hangingFetch();
        const client = new LunoraClient({ fetch: fetchImpl, url: "http://app.test" });
        const controller = new AbortController();

        controller.abort();

        await expect(abortName(client.mutation(fnRef("todos.set"), {}, { signal: controller.signal }))).resolves.toBe("AbortError");
        expect(fetchImpl).not.toHaveBeenCalled();

        client.close();
    });

    it("stops waiting on a mutation without retracting the request already sent", async () => {
        expect.assertions(2);

        const { fetchImpl, signals } = hangingFetch();
        const client = new LunoraClient({ fetch: fetchImpl, url: "http://app.test" });
        const controller = new AbortController();
        const outcome = abortName(client.mutation(fnRef("todos.set"), { text: "a" }, { signal: controller.signal }));

        await vi.waitFor(() => {
            expect(fetchImpl).toHaveBeenCalledTimes(1);
        });
        controller.abort();

        await outcome;

        // The write is on the wire and may commit: the abort only releases the caller.
        expect(signals[0]?.aborted).toBe(false);

        client.close();
    });

    it("stops waiting on a queued mutation but leaves it queued for replay", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const { sockets, WebSocket } = createSocketHarness();
        const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } }));
        const client = new LunoraClient({
            fetch: fetchImpl,
            heartbeatIntervalMs: 0,
            offlineQueue: { queueBeforeFirstConnect: true },
            persistence: createInMemoryPersistence(),
            url: "http://app.test",
            WebSocket,
        });

        client.subscribe(fnRef("todos.list"), {}, () => undefined);

        const controller = new AbortController();
        const outcome = abortName(client.mutation(fnRef("todos.set"), { text: "a" }, { signal: controller.signal }));

        await settle();
        controller.abort();

        await expect(outcome).resolves.toBe("AbortError");
        expect(client.pendingCount()).toBe(1);

        sockets[0]?.open();
        await settle();

        expect(fetchImpl).toHaveBeenCalledTimes(1);

        client.close();
    });

    it("unsubscribes when the signal aborts", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const { sockets, WebSocket } = createSocketHarness();
        const client = new LunoraClient({ fetch: vi.fn<typeof fetch>(), heartbeatIntervalMs: 0, url: "http://app.test", WebSocket });
        const controller = new AbortController();

        client.subscribe(fnRef("todos.list"), {}, () => undefined, { signal: controller.signal });
        await settle();
        sockets[0]?.open();
        await settle();
        controller.abort();

        expect(sockets[0]?.frames().filter((frame) => frame.type === "unsubscribe")).toHaveLength(1);

        // Aborting a second time (or unsubscribing by hand afterwards) must not unsubscribe again.
        controller.abort();

        expect(sockets[0]?.frames().filter((frame) => frame.type === "unsubscribe")).toHaveLength(1);

        client.close();
    });

    it("unsubscribes when the first replayed value aborts the signal", async () => {
        expect.assertions(1);

        vi.useFakeTimers();

        const { sockets, WebSocket } = createSocketHarness();
        const client = new LunoraClient({ fetch: vi.fn<typeof fetch>(), heartbeatIntervalMs: 0, url: "http://app.test", WebSocket });
        const first = new AbortController();

        client.subscribe(fnRef("todos.list"), {}, () => undefined);
        await settle();
        sockets[0]?.open();
        await settle();
        sockets[0]?.receive({ id: sockets[0]?.frames()[0]?.id, type: "ack" });
        sockets[0]?.receive({ data: [1], id: sockets[0]?.frames()[0]?.id, type: "data" });

        // A "take the first value, then stop" consumer joins the shared subscription and aborts inside the replay.
        const seen: unknown[] = [];

        client.subscribe(
            fnRef("todos.list"),
            {},
            (value) => {
                seen.push(value);
                first.abort();
            },
            { signal: first.signal },
        );
        sockets[0]?.receive({ data: [2], id: sockets[0]?.frames()[0]?.id, type: "data" });

        // The aborted subscriber is gone, so the second push never reaches it.
        expect(seen).toStrictEqual([[1]]);

        client.close();
    });

    it("registers nothing for a subscribe whose signal is already aborted", async () => {
        expect.assertions(1);

        vi.useFakeTimers();

        const { sockets, WebSocket } = createSocketHarness();
        const client = new LunoraClient({ fetch: vi.fn<typeof fetch>(), heartbeatIntervalMs: 0, url: "http://app.test", WebSocket });
        const controller = new AbortController();

        controller.abort();
        client.subscribe(fnRef("todos.list"), {}, () => undefined, { signal: controller.signal });
        await settle();

        expect(sockets).toHaveLength(0);

        client.close();
    });

    it("stops waiting for hydration when the signal aborts", async () => {
        expect.assertions(1);

        const neverLoads: QueryCacheAdapter = {
            clear: async () => undefined,
            load: async () =>
                new Promise(() => {
                    /* a cache that never finishes loading */
                }),
            put: async () => undefined,
            remove: async () => undefined,
        };
        const client = new LunoraClient({ fetch: vi.fn<typeof fetch>(), hydrateOnStart: true, queryCache: neverLoads, url: "http://app.test" });
        const controller = new AbortController();
        const outcome = abortName(client.whenReady({ signal: controller.signal }));

        controller.abort();

        await expect(outcome).resolves.toBe("AbortError");

        client.close();
    });
});
