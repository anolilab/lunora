import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_AMBIGUOUS_SEND_ATTEMPTS } from "../src/client-tuning";
import { LunoraClient } from "../src/lunora-client";
import { createInMemoryPersistence } from "../src/persistence";
import { createSocketHarness, fnRef, jsonResponse, settle } from "./lib/harness";

const createConnectedClient = async (fetchImpl: typeof fetch) => {
    const { sockets, WebSocket } = createSocketHarness();
    const client = new LunoraClient({
        fetch: fetchImpl,
        heartbeatIntervalMs: 0,
        persistence: createInMemoryPersistence(),
        url: "http://app.test",
        WebSocket,
    });

    client.subscribe(fnRef("todos.list"), {}, () => undefined);
    await settle();
    sockets[0]?.open();
    await settle();

    return client;
};

describe("direct mutation whose response was lost", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it("retries under the same mutationId instead of rolling back a write that may have committed", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const mutationIds: (string | undefined)[] = [];
        let calls = 0;
        const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
            calls += 1;
            mutationIds.push((init?.headers as Record<string, string>)["x-lunora-mutation-id"]);

            if (calls === 1) {
                // The request reached the server and committed; the response never made it back.
                throw new TypeError("network connection lost");
            }

            return jsonResponse({ result: { ok: true } });
        });
        const client = await createConnectedClient(fetchImpl);
        const write = client.mutation(fnRef("todos.set"), { text: "a" });

        await vi.advanceTimersByTimeAsync(2000);

        await expect(write).resolves.toStrictEqual({ ok: true });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(mutationIds[1]).toBe(mutationIds[0]);

        client.close();
    });

    it("replays under the same mutationId even though the write's own commit invalidated its precondition", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const mutationIds: (string | undefined)[] = [];
        let calls = 0;
        let liveQueryChanged = false;
        const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
            calls += 1;
            mutationIds.push((init?.headers as Record<string, string>)["x-lunora-mutation-id"]);

            if (calls === 1) {
                // The write committed and its new value is pushed to the live query before the retry goes out.
                liveQueryChanged = true;

                throw new TypeError("network connection lost");
            }

            return jsonResponse({ result: { ok: true } });
        });
        const client = await createConnectedClient(fetchImpl);
        const write = client.mutation(fnRef("todos.set"), { text: "a" }, { precondition: () => !liveQueryChanged });

        await vi.advanceTimersByTimeAsync(2000);

        await expect(write).resolves.toStrictEqual({ ok: true });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(mutationIds[1]).toBe(mutationIds[0]);

        client.close();
    });

    it("still honours the precondition of a write queued because the socket was down", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } }));
        const { sockets, WebSocket } = createSocketHarness();
        const client = new LunoraClient({
            fetch: fetchImpl,
            heartbeatIntervalMs: 0,
            persistence: createInMemoryPersistence(),
            reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
            url: "http://app.test",
            WebSocket,
        });

        client.subscribe(fnRef("todos.list"), {}, () => undefined);
        await settle();
        sockets[0]?.open();
        await settle();
        sockets[0]?.triggerClose();

        const outcome = client.mutation(fnRef("todos.set"), { text: "a" }, { precondition: () => false }).then(
            () => "resolved",
            (error: unknown) => (error as { code?: string }).code,
        );

        await vi.advanceTimersByTimeAsync(10);
        sockets.at(-1)?.open();
        await vi.runAllTimersAsync();

        await expect(outcome).resolves.toBe("OFFLINE_PRECONDITION_FAILED");
        expect(fetchImpl).not.toHaveBeenCalled();

        client.close();
    });

    it("still rejects when the server reached a verdict", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ error: { code: "FORBIDDEN", message: "no" } }, { status: 403 }));
        const client = await createConnectedClient(fetchImpl);
        const outcome = client.mutation(fnRef("todos.set"), { text: "a" }).then(
            () => "resolved",
            (error: unknown) => (error as { code?: string }).code,
        );

        await vi.advanceTimersByTimeAsync(2000);

        await expect(outcome).resolves.toBe("FORBIDDEN");
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        client.close();
    });

    it("gives up after a bounded number of attempts and rolls the optimistic write back", async () => {
        expect.assertions(4);

        vi.useFakeTimers();

        const { sockets, WebSocket } = createSocketHarness();
        const fetchImpl = vi.fn<typeof fetch>(async () => new Response("<html>bad gateway</html>", { status: 502 }));
        const client = new LunoraClient({
            fetch: fetchImpl,
            heartbeatIntervalMs: 0,
            persistence: createInMemoryPersistence(),
            url: "http://app.test",
            WebSocket,
        });
        const received: unknown[] = [];

        client.subscribe(fnRef("counter:get"), {}, (value) => received.push(value));
        await settle();
        sockets[0]?.open();
        await settle();

        const [frame] = sockets[0]?.frames() ?? [];

        sockets[0]?.receive({ delta: 5, id: frame?.id, type: "delta" });

        const outcome = client.mutation(fnRef("counter:get"), {}, { optimistic: (current) => (typeof current === "number" ? current + 1 : 1) }).then(
            () => "resolved",
            (error: unknown) => (error as { code?: string }).code,
        );

        await vi.advanceTimersByTimeAsync(120_000);

        await expect(outcome).resolves.toBe("INTERNAL");
        // The write is not retried for ever, and its predicted value is taken back.
        expect(received).toStrictEqual([5, 6, 5]);
        expect(client.pendingCount()).toBe(0);
        // The direct send, then one replay per attempt the cap allows.
        expect(fetchImpl).toHaveBeenCalledTimes(MAX_AMBIGUOUS_SEND_ATTEMPTS + 1);

        client.close();
    });

    it("leaves an outbox app's failed write to reject as before", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const { sockets, WebSocket } = createSocketHarness();
        const outbox = { enqueue: vi.fn<() => Promise<void>>(async () => undefined) };
        const client = new LunoraClient({
            fetch: vi.fn<typeof fetch>(async () => {
                throw new TypeError("network connection lost");
            }),
            heartbeatIntervalMs: 0,
            outbox,
            url: "http://app.test",
            WebSocket,
        });

        client.subscribe(fnRef("todos.list"), {}, () => undefined);
        await settle();
        sockets[0]?.open();
        await settle();

        const outcome = client.mutation(fnRef("todos.set"), { text: "a" }).then(
            () => "resolved",
            (error: unknown) => (error as Error).name,
        );

        await vi.advanceTimersByTimeAsync(1000);

        await expect(outcome).resolves.toBe("TypeError");
        expect(outbox.enqueue).not.toHaveBeenCalled();

        client.close();
    });

    it("rejects at once, without queueing, when there is no fetch to send it with", async () => {
        expect.assertions(2);

        vi.useFakeTimers();
        vi.stubGlobal("fetch", undefined);

        const { sockets, WebSocket } = createSocketHarness();
        const client = new LunoraClient({ heartbeatIntervalMs: 0, persistence: createInMemoryPersistence(), url: "http://app.test", WebSocket });

        client.subscribe(fnRef("todos.list"), {}, () => undefined);
        await settle();
        sockets[0]?.open();
        await settle();

        let outcome: string | undefined;

        client.mutation(fnRef("todos.set"), { text: "a" }).catch((error: unknown) => {
            outcome = (error as { code?: string }).code;
        });

        await settle();

        // Nothing was ever sent, so nothing is retried: the caller hears about it on the first attempt.
        expect(outcome).toBe("INTERNAL");
        expect(client.pendingCount()).toBe(0);

        client.close();
    });
});
