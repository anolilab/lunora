import { afterEach, describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import { createInMemoryPersistence } from "../src/persistence";
import type { PersistenceAdapter } from "../src/types";
import { createSocketHarness, fnRef, jsonResponse, settle } from "./lib/harness";

const createClient = (
    persistence: PersistenceAdapter,
    { subscribe = true }: { subscribe?: boolean } = {},
    fetchImpl: typeof fetch = vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } })),
) => {
    const { sockets, WebSocket } = createSocketHarness();
    const client = new LunoraClient({
        fetch: fetchImpl,
        heartbeatIntervalMs: 0,
        offlineQueue: { queueBeforeFirstConnect: true },
        persistence,
        url: "http://app.test",
        WebSocket,
    });

    if (subscribe) {
        client.subscribe(fnRef("todos.list"), {}, () => undefined);
    }

    return { client, fetchImpl, sockets };
};

describe("closing a client with persisted writes queued", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("tells a caller whose queued write was persisted that it will still replay when the client closes", async () => {
        expect.assertions(2);

        const { client } = createClient(createInMemoryPersistence());
        const outcome = client.mutation(fnRef("todos.set"), { text: "a" }).then(
            () => undefined,
            (error: unknown) => error as { code?: string; persisted?: boolean },
        );

        await Promise.resolve();
        client.close();

        const error = await outcome;

        expect(error?.code).toBe("CLIENT_CLOSED");
        expect(error?.persisted).toBe(true);
    });

    it("replays, in the next session, a write whose caller was told the client closed", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const persistence = createInMemoryPersistence();
        const first = createClient(persistence);
        const outcome = first.client.mutation(fnRef("todos.set"), { text: "a" }).then(
            () => "resolved",
            (error: unknown) => (error as { code?: string }).code,
        );

        await settle();
        first.client.close();

        await expect(outcome).resolves.toBe("CLIENT_CLOSED");

        // A relaunch subscribes to nothing: hydration alone opens the socket for the restored write.
        const second = createClient(persistence, { subscribe: false });

        await settle();
        second.sockets[0]?.open();
        await settle();

        // The caller was told it failed, and the write still reaches the server.
        expect(second.fetchImpl).toHaveBeenCalledTimes(1);

        second.client.close();
    });
});
