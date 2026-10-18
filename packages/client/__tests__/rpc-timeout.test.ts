import { afterEach, describe, expect, it, vi } from "vitest";

import { TransportError } from "../src/errors";
import { LunoraClient } from "../src/lunora-client";
import { createInMemoryPersistence } from "../src/persistence";
import { createSocketHarness, fnRef, jsonResponse, settle } from "./lib/harness";

/** A `fetch` that never answers — a stalled connection the platform has not yet given up on. */
const hang = (): Promise<Response> =>
    new Promise<Response>(() => {
        /* never settles */
    });

describe("rpc timeout", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("fails a stalled query with a retryable transport error instead of hanging", async () => {
        expect.assertions(1);

        vi.useFakeTimers();

        const client = new LunoraClient({ fetch: vi.fn<typeof fetch>(hang), rpcTimeoutMs: 100, url: "http://app.test" });
        const outcome = client.query(fnRef("todos.list"), {}).then(
            () => "resolved",
            (error: unknown) => error,
        );

        await vi.advanceTimersByTimeAsync(150);

        await expect(outcome).resolves.toBeInstanceOf(TransportError);

        client.close();
    });

    it("re-queues a stalled single replay and delivers it under the same mutationId on the retry", async () => {
        expect.assertions(4);

        vi.useFakeTimers();

        const { sockets, WebSocket } = createSocketHarness();
        const mutationIds: (string | undefined)[] = [];
        let calls = 0;
        const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
            calls += 1;
            mutationIds.push((init?.headers as Record<string, string>)["x-lunora-mutation-id"]);

            return calls === 1 ? hang() : jsonResponse({ result: { ok: true } });
        });
        const client = new LunoraClient({
            fetch: fetchImpl,
            heartbeatIntervalMs: 0,
            offlineQueue: { queueBeforeFirstConnect: true },
            persistence: createInMemoryPersistence(),
            rpcTimeoutMs: 100,
            url: "http://app.test",
            WebSocket,
        });

        client.subscribe(fnRef("todos.list"), {}, () => undefined);

        const write = client.mutation(fnRef("todos.set"), { text: "a" });
        let settled = false;

        const outcome = write.finally(() => {
            settled = true;
        });

        await settle();
        sockets[0]?.open();
        await vi.advanceTimersByTimeAsync(150);

        // The stalled attempt neither settled the write nor dropped it from the queue.
        expect(settled).toBe(false);
        expect(client.pendingCount()).toBe(1);

        await vi.advanceTimersByTimeAsync(5000);
        await outcome;

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(mutationIds[1]).toBe(mutationIds[0]);

        client.close();
    });

    it("re-queues a stalled batched replay instead of freezing the shard", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const { sockets, WebSocket } = createSocketHarness();
        let calls = 0;
        const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
            calls += 1;

            if (calls === 1) {
                return hang();
            }

            const body = JSON.parse(init?.body as string) as { calls: unknown[] };

            return jsonResponse({
                results: body.calls.map((_, id) => {
                    return { body: { result: { ok: true } }, id };
                }),
            });
        });
        const client = new LunoraClient({
            fetch: fetchImpl,
            heartbeatIntervalMs: 0,
            offlineQueue: { queueBeforeFirstConnect: true },
            persistence: createInMemoryPersistence(),
            rpcTimeoutMs: 100,
            url: "http://app.test",
            WebSocket,
        });

        client.subscribe(fnRef("todos.list"), {}, () => undefined);

        const writes = Promise.all([client.mutation(fnRef("todos.set"), { text: "a" }), client.mutation(fnRef("todos.set"), { text: "b" })]);

        await settle();
        sockets[0]?.open();
        await vi.advanceTimersByTimeAsync(150);

        expect(client.pendingCount()).toBe(2);

        await vi.advanceTimersByTimeAsync(5000);
        await writes;

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(client.pendingCount()).toBe(0);

        client.close();
    });
});
