import { afterEach, describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import { createInMemoryPersistence } from "../src/persistence";
import { createSocketHarness, fnRef, jsonResponse, settle } from "./lib/harness";

const createConnectedClient = async (fetchImpl: typeof fetch) => {
    const { sockets, WebSocket } = createSocketHarness();
    const client = new LunoraClient({
        fetch: fetchImpl,
        heartbeatIntervalMs: 0,
        offlineQueue: { replayRetry: { baseDelayMs: 10, maxDelayMs: 20 } },
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
});
