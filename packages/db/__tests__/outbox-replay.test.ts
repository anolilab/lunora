import type { OfflineExecutor } from "@tanstack/offline-transactions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    bindMutators,
    createCheckpointRegistry,
    createExecutorOutboxSink,
    defineCollections,
    defineMutator,
    lunoraCollectionOptions,
    OUTBOX_MUTATION_FN_NAME,
} from "../src";
import {
    createCheckpointRegistry as collectionsCreateCheckpointRegistry,
    defineCollections as collectionsDefineCollections,
    lunoraCollectionOptions as collectionsLunoraCollectionOptions,
} from "../src/collections";
import { bindMutators as mutatorsBindMutators, defineMutator as mutatorsDefineMutator } from "../src/mutators";

/** A fake `FunctionReference` — the binding only forwards it to the client. */
const ref = (name: string) => ({ __lunoraRef: name }) as never;

const usersList = ref("users:list");
const temporaryList = ref("temp:list");
const temporarySend = ref("temp:send");

const DROPPED_RE = /dropped/u;

/**
 * An in-memory `localStorage` shim. Without it Node has no storage and the
 * executor falls into online-only mode instead of the durable leader path
 * under test here.
 */
const memoryLocalStorage = (): {
    clear: () => void;
    getItem: (key: string) => string | null;
    key: (index: number) => string | null;
    readonly length: number;
    removeItem: (key: string) => void;
    setItem: (key: string, value: string) => void;
} => {
    const store = new Map<string, string>();

    return {
        clear: () => {
            store.clear();
        },
        getItem: (key: string) => store.get(key) ?? null,
        key: (index: number) => [...store.keys()][index] ?? null,
        get length() {
            return store.size;
        },
        removeItem: (key: string) => {
            store.delete(key);
        },
        setItem: (key: string, value: string) => {
            store.set(key, value);
        },
    };
};

/**
 * A minimal exclusive Web Locks shim (Node has no `navigator.locks`). The
 * executor's leader election prefers Web Locks; without it the fallback
 * BroadcastChannel election takes ~10s to claim leadership, and a non-leader
 * executor never drains the durable outbox.
 */
const memoryWebLocks = (): { request: (name: string, options: unknown, callback?: unknown) => Promise<unknown> } => {
    const tails = new Map<string, Promise<void>>();

    return {
        async request(name: string, optionsOrCallback: unknown, maybeCallback?: unknown): Promise<unknown> {
            const callback = (typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback) as (lock: unknown) => unknown;
            const options = (typeof optionsOrCallback === "function" ? {} : (optionsOrCallback ?? {})) as { ifAvailable?: boolean };
            const previous = tails.get(name);

            if (options.ifAvailable && previous !== undefined) {
                return callback(null);
            }

            let release!: () => void;
            const held = new Promise<void>((resolve) => {
                release = resolve;
            });
            const chained = (previous ?? Promise.resolve()).then(() => held);

            tails.set(name, chained);

            if (previous) {
                await previous;
            }

            try {
                return await callback({ mode: "exclusive", name });
            } finally {
                release();

                if (tails.get(name) === chained) {
                    tails.delete(name);
                }
            }
        },
    };
};

/** A mock `LunoraClient` carrying the identity + mutation surface the outbox replay path uses. */
const makeClient = (options?: { identity?: string | null; mutation?: () => Promise<unknown> }) => {
    const mutation = vi.fn<(reference: { __lunoraRef: string }, args: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>>(
        options?.mutation ?? (async () => "ok"),
    );

    const client = {
        confirmedMutationWatermark: () => 0,
        currentIdentity: () => options?.identity ?? "user-a",
        mutation,
        subscribe: vi.fn<() => () => void>(() => () => undefined),
    };

    return { client: client as never, mutation };
};

const executors: OfflineExecutor[] = [];

const buildDatabase = (client: never, options?: Parameters<typeof defineCollections>[2]) => {
    const database = defineCollections(client, { users: { list: usersList } }, options);

    executors.push(database.executor);

    return database;
};

describe("durable outbox lifecycle (unified outbox)", () => {
    beforeEach(() => {
        // Fresh durable storage per test (shared across executors within one test).
        vi.stubGlobal("localStorage", memoryLocalStorage());
        // The leader election schedules through `window` and prefers Web Locks.
        vi.stubGlobal("window", globalThis);
        vi.stubGlobal("navigator", { locks: memoryWebLocks() });
    });

    afterEach(() => {
        for (const executor of executors.splice(0)) {
            executor.dispose();
        }

        vi.unstubAllGlobals();
    });

    /** A raw `client.mutation` offline write, as the unified outbox persists it. */
    const outboxWrite = (overrides: Partial<Record<string, unknown>> = {}) =>
        ({
            args: { text: "hello" },
            clientId: "c1",
            functionPath: "messages:send",
            idempotencyKey: "c1:1",
            identity: "user-a",
            mutationId: 1,
            ...overrides,
        }) as never;

    it("replays a raw offline write through client.mutation with the original idempotency key", async () => {
        const { client, mutation } = makeClient();
        const database = buildDatabase(client);

        await database.executor.waitForInit();

        const sink = createExecutorOutboxSink(database.executor);

        await sink.enqueue(outboxWrite({ shardKey: "room-7" }));

        await vi.waitFor(() => {
            expect(mutation).toHaveBeenCalledTimes(1);
        });

        // The replay targets the persisted function path and resends the ORIGINAL
        // idempotency key (not a fresh id), so a committed-but-unacked retry is
        // deduped server-side; the shard routing survives the round-trip too.
        expect(mutation).toHaveBeenCalledWith({ __lunoraRef: "messages:send" }, { text: "hello" }, { mutationId: "c1:1", shardKey: "room-7" });

        await vi.waitFor(() => {
            expect(database.pendingCount()).toBe(0);
        });
    });

    it("drops a queued write whose captured identity no longer matches the signed-in user", async () => {
        const { client, mutation } = makeClient({ identity: "user-b" });
        const database = buildDatabase(client);

        await database.executor.waitForInit();

        const sink = createExecutorOutboxSink(database.executor);

        // The write was captured under user-a; the client is now user-b.
        await sink.enqueue(outboxWrite({ identity: "user-a" }));

        await vi.waitFor(() => {
            expect(database.pendingCount()).toBe(0);
        });

        // Dropped, never replayed as someone else.
        expect(mutation).not.toHaveBeenCalled();
    });

    it("retries a transient (code-less) failure until the write lands", { timeout: 10_000 }, async () => {
        let attempts = 0;
        const { client, mutation } = makeClient({
            mutation: async () => {
                attempts += 1;

                if (attempts === 1) {
                    // A network blip: no server error code → transient → retried.
                    throw new Error("socket hang up");
                }

                return "ok";
            },
        });
        const onWriteRejected = vi.fn<() => void>();
        const database = buildDatabase(client, { onWriteRejected });

        await database.executor.waitForInit();

        const sink = createExecutorOutboxSink(database.executor);

        await sink.enqueue(outboxWrite());

        // First attempt fails, the executor backs off (~1s) and replays.
        await vi.waitFor(
            () => {
                expect(mutation).toHaveBeenCalledTimes(2);
            },
            { interval: 100, timeout: 8000 },
        );

        // Both attempts replayed under the SAME idempotency key.
        expect(mutation.mock.calls[0]?.[2]).toStrictEqual({ mutationId: "c1:1", shardKey: undefined });
        expect(mutation.mock.calls[1]?.[2]).toStrictEqual({ mutationId: "c1:1", shardKey: undefined });

        await vi.waitFor(() => {
            expect(database.pendingCount()).toBe(0);
        });

        // A transient failure is retried, never reported as a permanent rejection.
        expect(onWriteRejected).not.toHaveBeenCalled();
    });

    it("drops a transport transaction that carries no replay metadata without calling the server", async () => {
        const { client, mutation } = makeClient();
        const database = buildDatabase(client);

        await database.executor.waitForInit();

        const users = database.collections.users as unknown as {
            insert: (row: Record<string, unknown>) => unknown;
            subscribeChanges: (cb: () => void) => unknown;
        };

        users.subscribeChanges(() => undefined);

        // A reserved-handler transaction with no replay metadata: there is no
        // function path to replay, so the write must be dropped, not sent.
        // (autoCommit: false — the upstream auto-commit rethrows inside a .catch,
        // which would surface as an unhandled rejection.)
        const transaction = database.executor.createOfflineTransaction({ autoCommit: false, mutationFnName: OUTBOX_MUTATION_FN_NAME }) as {
            commit: () => Promise<unknown>;
            mutate: (callback: () => void) => unknown;
        };

        transaction.mutate(() => {
            users.insert({ _id: "junk-row" });
        });

        await expect(transaction.commit()).rejects.toThrow(DROPPED_RE);

        await vi.waitFor(() => {
            expect(database.pendingCount()).toBe(0);
        });

        expect(mutation).not.toHaveBeenCalled();
    });

    /** The writable `temp` collection — one definition for every test that queues a `db.actions.*` write. */
    const temporaryDefinition = (shardKey?: string) => {
        return {
            temp: {
                insert: {
                    mutation: temporarySend,
                    optimistic: (input: { text: string }, id: string) => {
                        return { _creationTime: 0, _id: id, text: input.text };
                    },
                    toArgs: (row: Record<string, unknown> & { _id: string }) => {
                        return { id: row._id, text: row.text };
                    },
                },
                list: temporaryList,
                ...(shardKey === undefined ? {} : { shardKey }),
            },
        };
    };

    /**
     * Persist a write against a `temp` collection under a first executor, then
     * dispose it mid-flight — simulating a deploy that removes the collection,
     * or (with an `identity`) the session that queued the write ending.
     * @returns The optimistic id the queued write carried.
     */
    const strandWrite = async (identity?: string): Promise<string> => {
        const { client: oldClient } = makeClient({
            ...(identity === undefined ? {} : { identity }),
            mutation: () =>
                new Promise(() => {
                    /* in-flight forever — the write stays persisted */
                }),
        });

        const oldDatabase = defineCollections(oldClient, temporaryDefinition());

        await oldDatabase.executor.waitForInit();

        const { id } = oldDatabase.actions.temp({ text: "stranded" });

        // Let the write persist (and start its never-settling send), then kill
        // the app "before the deploy".
        await vi.waitFor(() => {
            expect(oldDatabase.executor.getPendingCount()).toBeGreaterThan(0);
        });

        oldDatabase.executor.dispose();

        return id;
    };

    /** The "next session": `temp` is still writable, so a restored write finds its mutationFn and replays. */
    const buildWritableReload = (client: never, options?: Parameters<typeof defineCollections>[2]) => {
        const database = defineCollections(client, temporaryDefinition(), options);

        executors.push(database.executor);

        return database;
    };

    it("drops a queued collection write whose identity no longer matches, instead of replaying it as the new user", { timeout: 10_000 }, async () => {
        // Alice queues a write that never lands, then the tab dies.
        const id = await strandWrite("alice");

        // Same browser profile, same durable outbox — Bob is signed in now.
        const { client, mutation } = makeClient({ identity: "bob" });
        const onWriteRejected = vi.fn<(event: { code?: string; collection: string; error: Error; row?: { _id: string } }) => void>();

        const database = buildWritableReload(client, { onWriteRejected });

        // Init resolves once the persisted write is loaded and scheduled (its
        // replay is fire-and-forget after that), so the wait below can't observe
        // a still-empty queue and pass vacuously.
        await database.executor.waitForInit();

        // Wait on the restored write settling either way, so the assertions below
        // report what actually happened to it rather than a bare timeout.
        await vi.waitFor(
            () => {
                expect(database.pendingCount()).toBe(0);
            },
            { timeout: 8000 },
        );

        // Never sent: Alice's write must not execute under Bob's bearer.
        expect(mutation).not.toHaveBeenCalled();
        expect(onWriteRejected).toHaveBeenCalledTimes(1);

        const event = onWriteRejected.mock.calls[0]![0];

        expect(event.collection).toBe("temp");
        expect(event.error.message).toContain("identity changed");
        expect(event.row?._id).toBe(id);
    });

    it("replays a queued collection write when the same identity is still signed in", { timeout: 10_000 }, async () => {
        await strandWrite("alice");

        const { client, mutation } = makeClient({ identity: "alice" });
        const onWriteRejected = vi.fn<() => void>();
        const database = buildWritableReload(client, { onWriteRejected });

        await vi.waitFor(
            () => {
                expect(mutation).toHaveBeenCalledTimes(1);
            },
            { timeout: 8000 },
        );

        await vi.waitFor(() => {
            expect(database.pendingCount()).toBe(0);
        });

        expect(onWriteRejected).not.toHaveBeenCalled();
    });

    it("routes a sharded collection's write to the shard its list subscription reads", async () => {
        const { client, mutation } = makeClient();
        const database = defineCollections(client, temporaryDefinition("acme"));

        executors.push(database.executor);

        await database.executor.waitForInit();

        database.actions.temp({ text: "tenant write" });

        await vi.waitFor(() => {
            expect(mutation).toHaveBeenCalledTimes(1);
        });

        // Without the shard key the write lands in the default shard while the
        // `acme` subscription reads another DO — committed, ack'd, invisible.
        expect(mutation.mock.calls[0]![2]).toMatchObject({ shardKey: "acme" });
    });

    /** The "new deploy": `temp` became read-only — its insert binding (and so its mutationFn) is gone. */
    const buildReadOnlyDeploy = (client: never, options?: Parameters<typeof defineCollections>[2]) => {
        const database = defineCollections(client, { temp: { list: temporaryList }, users: { list: usersList } }, options);

        executors.push(database.executor);

        return database;
    };

    it("reports a persisted write whose mutation fn was removed as UNKNOWN_MUTATION_FN", { timeout: 10_000 }, async () => {
        const id = await strandWrite();

        // After the deploy the persisted write is restored from storage, but its
        // mutationFn no longer exists.
        const { client, mutation } = makeClient();
        const onWriteRejected = vi.fn<(event: { code?: string; collection: string; error: Error; row?: { _id: string } }) => void>();

        buildReadOnlyDeploy(client, { onWriteRejected });

        await vi.waitFor(
            () => {
                expect(onWriteRejected).toHaveBeenCalledTimes(1);
            },
            { timeout: 8000 },
        );

        const event = onWriteRejected.mock.calls[0]![0];

        expect(event.code).toBe("UNKNOWN_MUTATION_FN");
        expect(event.collection).toBe("temp");
        expect(event.error.message).toContain('"temp"');
        // The recovered optimistic row describes the dropped write to the user.
        expect(event.row?._id).toBe(id);
        expect(mutation).not.toHaveBeenCalled();
    });

    it("survives a throwing onWriteRejected listener in the unknown-fn drop path", { timeout: 10_000 }, async () => {
        await strandWrite();

        const { client } = makeClient();
        const onWriteRejected = vi.fn<() => void>(() => {
            throw new Error("listener exploded");
        });
        const database = buildReadOnlyDeploy(client, { onWriteRejected });

        // The drop still completes — the listener's throw never escapes into the
        // executor and never turns the terminal verdict into a retry loop.
        await vi.waitFor(
            () => {
                expect(onWriteRejected).toHaveBeenCalledTimes(1);
            },
            { timeout: 8000 },
        );

        await vi.waitFor(() => {
            expect(database.pendingCount()).toBe(0);
        });
    });
});

describe("collection options surface", () => {
    it("scope() is a no-op for an unscoped collection", () => {
        const { client } = makeClient();
        const subscribeMock = (client as { subscribe: ReturnType<typeof vi.fn> }).subscribe;

        const { scope } = lunoraCollectionOptions({ client, list: usersList });

        expect(() => {
            scope({ channelId: "c1" });
        }).not.toThrow();

        // No subscription opened — an unscoped collection can't be re-pointed.
        expect(subscribeMock).not.toHaveBeenCalled();
    });

    it("derives the collection id from the list ref and honours an explicit id", () => {
        const { client } = makeClient();

        const derived = lunoraCollectionOptions({ client, list: usersList });
        const explicit = lunoraCollectionOptions({ client, id: "custom", list: usersList });

        expect(derived.config.id).toBe("users:list");
        expect(explicit.config.id).toBe("custom");
        // Live queries get ordered indexes automatically as they filter/sort.
        expect(derived.config.autoIndex).toBe("eager");
    });
});

describe("subpath barrels", () => {
    it("@lunora/db/collections re-exports the read-path surface", () => {
        expect(collectionsDefineCollections).toBe(defineCollections);
        expect(collectionsLunoraCollectionOptions).toBe(lunoraCollectionOptions);
        expect(collectionsCreateCheckpointRegistry).toBe(createCheckpointRegistry);
    });

    it("@lunora/db/mutators re-exports the client-mutator runtime", () => {
        expect(mutatorsBindMutators).toBe(bindMutators);
        expect(mutatorsDefineMutator).toBe(defineMutator);
    });
});
