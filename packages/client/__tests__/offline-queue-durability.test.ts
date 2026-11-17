import { afterEach, describe, expect, it, vi } from "vitest";

import type { QueuedMutation } from "../src/offline-queue";
import { OfflineQueue } from "../src/offline-queue";
import { createInMemoryPersistence } from "../src/persistence";
import type { PersistenceAdapter } from "../src/types";
import { createQueueingClient, fnRef, settle } from "./lib/harness";

describe("offline queue durability", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it("does not leave a record behind when the write replays before its append landed", async () => {
        expect.assertions(1);

        vi.useFakeTimers();

        const inner = createInMemoryPersistence();
        let openGate: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            openGate = resolve;
        });
        const slow: PersistenceAdapter = {
            ...inner,
            append: async (mutation) => {
                await gate;
                await inner.append(mutation);
            },
        };
        const { client, sockets } = createQueueingClient(slow);
        const write = client.mutation(fnRef("todos.set"), { text: "a" });

        await settle();
        sockets[0]?.open();
        await settle();
        await write;

        // The replay settled and removed its record while the append was still pending; now it lands.
        openGate();
        await settle();

        await expect(inner.load()).resolves.toStrictEqual([]);

        client.close();
    });

    it("re-persists a write whose append failed when the page is hidden, and stops listening once closed", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const windowTarget = new EventTarget();
        const documentTarget = Object.assign(new EventTarget(), { visibilityState: "hidden" });

        vi.stubGlobal("addEventListener", windowTarget.addEventListener.bind(windowTarget));
        vi.stubGlobal("removeEventListener", windowTarget.removeEventListener.bind(windowTarget));
        vi.stubGlobal("document", documentTarget);

        const inner = createInMemoryPersistence();
        let appends = 0;
        const flaky: PersistenceAdapter = {
            ...inner,
            append: async (mutation) => {
                appends += 1;

                if (appends === 1) {
                    throw new Error("QuotaExceededError");
                }

                await inner.append(mutation);
            },
        };
        const { client } = createQueueingClient(flaky);
        const write = client.mutation(fnRef("todos.set"), { text: "a" });

        write.catch(() => undefined);
        await settle();

        await expect(inner.load()).resolves.toStrictEqual([]);

        documentTarget.dispatchEvent(new Event("visibilitychange"));
        await settle();

        await expect(inner.load()).resolves.toHaveLength(1);

        client.close();
        appends = 0;
        windowTarget.dispatchEvent(new Event("pagehide"));
        await settle();

        expect(appends).toBe(0);
    });
});

describe("offline queue append retries", () => {
    const entry = (identity: string): QueuedMutation => {
        return { args: {}, functionPath: "todos.set", identity, reject: () => undefined, resolve: () => undefined };
    };

    /** A store whose first append stays pending until the test rejects it. */
    const failFirstAppend = () => {
        const inner = createInMemoryPersistence();
        let failAppend: () => void = () => undefined;
        let calls = 0;
        const store: PersistenceAdapter = {
            ...inner,
            append: async (mutation) => {
                calls += 1;

                if (calls === 1) {
                    await new Promise<never>((_resolve, reject) => {
                        failAppend = () => {
                            reject(new Error("QuotaExceededError"));
                        };
                    });
                }

                await inner.append(mutation);
            },
        };

        return {
            fail: () => {
                failAppend();
            },
            inner,
            store,
        };
    };

    it("still retries an append that fails while a replay holds the write out of the queue", async () => {
        expect.assertions(2);

        const { fail, inner, store } = failFirstAppend();
        const queue = new OfflineQueue({}, { persistence: store });

        queue.enqueue(entry("a"));

        // A replay drains the queue, and the append is rejected while it is away.
        const drained = queue.drain();

        fail();
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        // The replay hit a transient failure and returned the write.
        queue.requeue(drained);
        queue.flushUnpersisted();
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(queue.size).toBe(1);
        await expect(inner.load()).resolves.toHaveLength(1);
    });

    it("retries a failed append under the identity stamped while it was in flight", async () => {
        expect.assertions(1);

        const { fail, inner, store } = failFirstAppend();
        const queue = new OfflineQueue({}, { persistence: store });

        queue.enqueue(entry("a"));
        queue.restampIdentity("a", "b");
        fail();
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
        queue.flushUnpersisted();
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        await expect(inner.load()).resolves.toMatchObject([{ identity: "b" }]);
    });

    it("stops retrying a write that was rejected as unpersisted when the client closed", async () => {
        expect.assertions(1);

        const { fail, inner, store } = failFirstAppend();
        const queue = new OfflineQueue({}, { persistence: store });

        queue.enqueue(entry("a"));
        fail();
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
        queue.clear();
        queue.flushUnpersisted();
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        await expect(inner.load()).resolves.toStrictEqual([]);
    });

    it("stops retrying once the write settles", async () => {
        expect.assertions(1);

        const { fail, inner, store } = failFirstAppend();
        const queue = new OfflineQueue({}, { persistence: store });

        queue.enqueue(entry("a"));

        const [drained] = queue.drain();

        fail();
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
        queue.discard(drained?.id ?? "");
        queue.flushUnpersisted();
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        await expect(inner.load()).resolves.toStrictEqual([]);
    });

    it("starts one append per record when the page-hide events flush back to back", async () => {
        expect.assertions(3);

        const inner = createInMemoryPersistence();
        let release: () => void = () => undefined;
        const appended: string[] = [];
        let calls = 0;
        const store: PersistenceAdapter = {
            ...inner,
            append: async (mutation) => {
                calls += 1;

                if (calls === 1) {
                    throw new Error("QuotaExceededError");
                }

                appended.push(mutation.id);
                // The retry stays in flight until the test lets it land.
                await new Promise<void>((resolve) => {
                    release = resolve;
                });
                await inner.append(mutation);
            },
        };
        const queue = new OfflineQueue({}, { persistence: store });

        queue.enqueue(entry("a"));
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        // `visibilitychange` then `pagehide`, while the first retry is still running.
        queue.flushUnpersisted();
        queue.flushUnpersisted();

        expect(appended).toHaveLength(1);

        release();
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(appended).toHaveLength(1);
        await expect(inner.load()).resolves.toHaveLength(1);
    });

    it("retries a rejected retry on the next flush", async () => {
        expect.assertions(2);

        const inner = createInMemoryPersistence();
        let calls = 0;
        const store: PersistenceAdapter = {
            ...inner,
            append: async (mutation) => {
                calls += 1;

                if (calls <= 2) {
                    throw new Error("QuotaExceededError");
                }

                await inner.append(mutation);
            },
        };
        const queue = new OfflineQueue({}, { persistence: store });
        const settleTick = async (): Promise<void> =>
            new Promise((resolve) => {
                setTimeout(resolve, 0);
            });

        queue.enqueue(entry("a"));
        await settleTick();
        queue.flushUnpersisted();
        await settleTick();
        queue.flushUnpersisted();
        await settleTick();

        expect(calls).toBe(3);
        await expect(inner.load()).resolves.toHaveLength(1);
    });
});
