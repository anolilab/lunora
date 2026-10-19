import { afterEach, describe, expect, it, vi } from "vitest";

import { OfflineQueue } from "../src/offline-queue";
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

    // `clear()` used to read the answer off the bookkeeping maps: an append still in flight is in
    // neither, so it was reported as persisted even if that append then failed.
    describe("a write whose append is still in flight when the queue is cleared", () => {
        const closedWith = async (settleAppend: (append: { reject: (reason: Error) => void; resolve: () => void }) => void) => {
            let append: { reject: (reason: Error) => void; resolve: () => void } | undefined;
            const persistence = {
                ...createInMemoryPersistence(),
                append: async () =>
                    new Promise<void>((resolve, reject) => {
                        append = { reject, resolve };
                    }),
            };
            const queue = new OfflineQueue({}, { persistence });
            const outcome = new Promise<{ persisted?: boolean }>((resolve) => {
                queue.enqueue({ args: {}, functionPath: "a", reject: resolve as (error: unknown) => void, resolve: () => undefined });
            });

            queue.clear();

            if (append === undefined) {
                throw new Error("append was never started");
            }

            settleAppend(append);

            return outcome;
        };

        it("reports persisted: false when the append then fails", async () => {
            expect.assertions(1);

            const error = await closedWith(({ reject }) => {
                reject(new Error("quota exceeded"));
            });

            expect(error.persisted).toBe(false);
        });

        it("reports persisted: true when the append lands", async () => {
            expect.assertions(1);

            const error = await closedWith(({ resolve }) => {
                resolve();
            });

            expect(error.persisted).toBe(true);
        });
    });
});
