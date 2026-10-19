import { afterEach, describe, expect, it, vi } from "vitest";

import { createInMemoryPersistence } from "../src/persistence";
import { createQueueingClient, fnRef, settle } from "./lib/harness";

describe("closing a client with persisted writes queued", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("tells a caller whose queued write was persisted that it will still replay when the client closes", async () => {
        expect.assertions(2);

        const { client } = createQueueingClient(createInMemoryPersistence());
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
        const first = createQueueingClient(persistence);
        const outcome = first.client.mutation(fnRef("todos.set"), { text: "a" }).then(
            () => "resolved",
            (error: unknown) => (error as { code?: string }).code,
        );

        await settle();
        first.client.close();

        await expect(outcome).resolves.toBe("CLIENT_CLOSED");

        // A relaunch subscribes to nothing: hydration alone opens the socket for the restored write.
        const second = createQueueingClient(persistence, { subscribe: false });

        await settle();
        second.sockets[0]?.open();
        await settle();

        // The caller was told it failed, and the write still reaches the server.
        expect(second.fetchImpl).toHaveBeenCalledTimes(1);

        second.client.close();
    });
});
