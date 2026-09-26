import { LunoraClient } from "@lunora/client";
import type { OfflineExecutor } from "@tanstack/offline-transactions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WriteRejectedEvent } from "../src";
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
const makeClient = (options?: { baseline?: number; identity?: string | null; mutation?: () => Promise<unknown> }) => {
    const mutation = vi.fn<(reference: { __lunoraRef: string }, args: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>>(
        options?.mutation ?? (async () => "ok"),
    );

    // Mutable so a test can model the shape a real browser always has: the
    // durable replay starts before the app has resolved its session, and the
    // identity arrives afterwards.
    let identity: null | string = options?.identity === undefined ? "user-a" : options.identity;
    // The cursor the client's live queries have reached. Mutable so a test can
    // advance it BETWEEN composing a write and its replay — the window that makes
    // re-sampling the baseline wrong.
    let baseline: number | undefined = options?.baseline;

    const client = {
        confirmedMutationWatermark: () => 0,
        currentBaseline: () => baseline,
        currentIdentity: () => identity,
        mutation,
        // Mirrors `LunoraClient.replayIdentityVerdict`: nobody signed in yet is
        // "unknown" (hold the write), a different user is "mismatch" (drop it). A
        // match carries the credential it was judged under, which the replay must
        // hand back; `{ judged }` stands in for the client's opaque one.
        replayIdentityVerdict: (stamped: null | string | undefined) => {
            if (stamped === identity) {
                return { credential: { judged: stamped }, verdict: "match" as const };
            }

            return { verdict: identity === null ? ("unknown" as const) : ("mismatch" as const) };
        },
        subscribe: vi.fn<() => () => void>(() => () => undefined),
    };

    const setBaseline = (next: number | undefined): void => {
        baseline = next;
    };

    return {
        client: client as never,
        mutation,
        setBaseline,
        signIn: (next: null | string) => {
            identity = next;
        },
    };
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
        expect(mutation).toHaveBeenCalledWith(
            { __lunoraRef: "messages:send" },
            { text: "hello" },
            { mutationId: "c1:1", replayBaseline: null, replayCredential: { judged: "user-a" }, shardKey: "room-7" },
        );

        await vi.waitFor(() => {
            expect(database.pendingCount()).toBe(0);
        });
    });

    // The write's CDC baseline has to survive the executor round-trip. By the time
    // a replay runs, this client has advanced to a newer cursor — precisely the
    // state a `.dropStalePatches()` table must judge the write against — so
    // letting `client.mutation` sample its own baseline there makes every stale
    // write look fresh and clobber.
    it("replays under the baseline the write was composed at, not one sampled at replay time", async () => {
        const { client, mutation } = makeClient();
        const database = buildDatabase(client);

        await database.executor.waitForInit();

        const sink = createExecutorOutboxSink(database.executor);

        await sink.enqueue(outboxWrite({ baselineSeq: 10, shardKey: "room-7" }));

        await vi.waitFor(() => {
            expect(mutation).toHaveBeenCalledTimes(1);
        });

        expect(mutation).toHaveBeenCalledWith(
            { __lunoraRef: "messages:send" },
            { text: "hello" },
            { mutationId: "c1:1", replayBaseline: 10, replayCredential: { judged: "user-a" }, shardKey: "room-7" },
        );
    });

    // `{ seq: undefined }` is not the same as omitting the option: omitting it
    // tells `client.mutation` to sample the current cursor, which is the clobber.
    // A write queued with no live subscription has to pin "no baseline" instead.
    it("pins `no baseline` for a write composed without one, rather than letting the replay sample", async () => {
        const { client, mutation } = makeClient();
        const database = buildDatabase(client);

        await database.executor.waitForInit();

        const sink = createExecutorOutboxSink(database.executor);

        await sink.enqueue(outboxWrite({ shardKey: "room-7" }));

        await vi.waitFor(() => {
            expect(mutation).toHaveBeenCalledTimes(1);
        });

        const options = mutation.mock.calls[0]?.[2] as { replayBaseline?: null | number };

        // `null`, not absent: absent tells `client.mutation` to sample the current
        // cursor, which is the clobber this exists to prevent.
        expect(options.replayBaseline).toBeNull();
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

    // No `expect.assertions` here (nor in this file's other `vi.waitFor` tests):
    // waitFor re-runs its callback until it passes, so the assertion count is a
    // function of timing, not of what the test checked.
    it("reports the reserved handler's identity drop on onWriteRejected instead of dropping it silently", async () => {
        const { client } = makeClient({ identity: "user-b" });
        const onWriteRejected = vi.fn<(event: { code?: string; collection: string; error: Error; row?: { _id: string } }) => void>();
        const database = buildDatabase(client, { onWriteRejected });

        await database.executor.waitForInit();

        const sink = createExecutorOutboxSink(database.executor);

        await sink.enqueue(outboxWrite({ identity: "user-a" }));

        await vi.waitFor(() => {
            expect(onWriteRejected).toHaveBeenCalledTimes(1);
        });

        const event = onWriteRejected.mock.calls[0]![0];

        // The raw outbox path targets a function, not a collection, so the
        // persisted path is what names the dropped write to the consumer.
        expect(event.collection).toBe("messages:send");
        expect(event.error.message).toContain("identity changed");
    });

    it("holds a queued write when no identity is established yet, then replays it once one arrives", { timeout: 10_000 }, async () => {
        // The shape every reload has: `startOfflineExecutor` replays from its own
        // constructor, before the app has resolved its session and called
        // `setAuthToken`, so `currentIdentity()` is null while the replay runs.
        // Dropping here would destroy the QUEUING user's own offline writes —
        // strictly worse than the cross-user replay the guard exists to stop.
        const { client, mutation, signIn } = makeClient({ identity: null });
        const onWriteRejected = vi.fn<() => void>();
        const database = buildDatabase(client, { onWriteRejected });

        await database.executor.waitForInit();

        const sink = createExecutorOutboxSink(database.executor);

        await sink.enqueue(outboxWrite({ identity: "user-a" }));

        // Held, not dropped: it stays in the durable outbox across replay
        // attempts instead of being removed as a terminal verdict.
        await vi.waitFor(() => {
            expect(database.pendingCount()).toBeGreaterThan(0);
        });

        expect(mutation).not.toHaveBeenCalled();
        expect(onWriteRejected).not.toHaveBeenCalled();

        signIn("user-a");

        await vi.waitFor(
            () => {
                expect(mutation).toHaveBeenCalledTimes(1);
            },
            { interval: 100, timeout: 8000 },
        );
    });

    // The worker refuses a cookie-session replay whose cookie now belongs to
    // someone else. That is not a verdict on the write: the next attempt's
    // identity guard settles it against who is signed in by then.
    it("holds a write the worker refused with IDENTITY_MISMATCH, then drops it once another user is known", { timeout: 10_000 }, async () => {
        const mismatch = Object.assign(new Error("the session changed since this write was queued"), { code: "IDENTITY_MISMATCH" });
        const onWriteRejected = vi.fn<(event: { code?: string }) => void>();
        const { client, mutation, signIn } = makeClient({
            mutation: async () => {
                // The client learns who holds the cookie from the refusal.
                signIn("user-b");

                throw mismatch;
            },
        });
        const database = buildDatabase(client, { onWriteRejected });

        await database.executor.waitForInit();

        const sink = createExecutorOutboxSink(database.executor);

        await sink.enqueue(outboxWrite());

        await vi.waitFor(() => {
            expect(mutation).toHaveBeenCalledTimes(1);
        });
        await vi.waitFor(
            () => {
                expect(onWriteRejected).toHaveBeenCalledTimes(1);
            },
            { interval: 100, timeout: 8000 },
        );

        expect(database.pendingCount()).toBe(0);
        // Sent once, naming the user who queued it; the retry never went out.
        expect(mutation).toHaveBeenCalledTimes(1);
        expect(mutation.mock.calls[0]?.[2]).toMatchObject({ replayCredential: { judged: "user-a" } });
        // Dropped by the identity guard, not by the refusal itself.
        expect(onWriteRejected.mock.calls.map(([event]) => event.code)).toStrictEqual([undefined]);
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

        // Both attempts replayed under the SAME idempotency key — and the same
        // pinned baseline, so a retry that lands minutes later is still judged
        // against what the write's author could see.
        expect(mutation.mock.calls[0]?.[2]).toStrictEqual({
            mutationId: "c1:1",
            replayBaseline: null,
            replayCredential: { judged: "user-a" },
            shardKey: undefined,
        });
        expect(mutation.mock.calls[1]?.[2]).toStrictEqual({
            mutationId: "c1:1",
            replayBaseline: null,
            replayCredential: { judged: "user-a" },
            shardKey: undefined,
        });

        await vi.waitFor(() => {
            expect(database.pendingCount()).toBe(0);
        });

        // A transient failure is retried, never reported as a permanent rejection.
        expect(onWriteRejected).not.toHaveBeenCalled();
    });

    it("rolls the write's optimistic value back when the replay is permanently rejected", async () => {
        const { client } = makeClient({
            mutation: async () => {
                // A coded verdict — permanent, so the write is dropped, not retried.
                const error = new Error("forbidden") as Error & { code?: string };

                error.code = "FORBIDDEN";

                throw error;
            },
        });
        const onWriteRejected = vi.fn<() => void>();
        const database = buildDatabase(client, { onWriteRejected });

        await database.executor.waitForInit();

        const sink = createExecutorOutboxSink(database.executor);
        const onRejected = vi.fn<() => void>();

        await sink.enqueue(outboxWrite({ onRejected }));

        await vi.waitFor(() => {
            expect(onWriteRejected).toHaveBeenCalledTimes(1);
        });

        // Without this the rejected prediction stays on screen until an unrelated
        // frame or a reload — the rejection reaches the app but never the cache.
        expect(onRejected).toHaveBeenCalledTimes(1);
    });

    it("leaves the optimistic value alone while a transient failure is retried, and drops the handle once it commits", { timeout: 10_000 }, async () => {
        let attempts = 0;
        const { client, mutation } = makeClient({
            mutation: async () => {
                attempts += 1;

                if (attempts === 1) {
                    throw new Error("socket hang up");
                }

                return "ok";
            },
        });
        const database = buildDatabase(client);

        await database.executor.waitForInit();

        const sink = createExecutorOutboxSink(database.executor);
        const onRejected = vi.fn<() => void>();

        await sink.enqueue(outboxWrite({ onRejected }));

        await vi.waitFor(
            () => {
                expect(mutation).toHaveBeenCalledTimes(2);
            },
            { interval: 100, timeout: 8000 },
        );

        await vi.waitFor(() => {
            expect(database.pendingCount()).toBe(0);
        });

        // Never rolled back: the first failure was retriable, and the retry landed.
        expect(onRejected).not.toHaveBeenCalled();
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
    const strandWrite = async (identity?: string, baseline?: number): Promise<string> => {
        const { client: oldClient } = makeClient({
            ...(identity === undefined ? {} : { identity }),
            ...(baseline === undefined ? {} : { baseline }),
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

    // `db.actions.*` is a THIRD replay path, alongside the reserved
    // `__lunora_outbox__` handler and the built-in offline queue. It composes its
    // own `WriteProvenance`, so it has to capture the baseline there too —
    // otherwise the replay samples whatever cursor the client has reached by then,
    // which is the newer state the write is supposed to be judged against.
    it("replays a collection write under the cursor it was composed at, not the reload's", { timeout: 10_000 }, async () => {
        // Composed at cursor 10, stranded, then the app reloads already caught up
        // to 99 — the exact window that makes re-sampling wrong.
        await strandWrite("alice", 10);

        const { client, mutation } = makeClient({ baseline: 99, identity: "alice" });

        buildWritableReload(client);

        await vi.waitFor(
            () => {
                expect(mutation).toHaveBeenCalledTimes(1);
            },
            { timeout: 8000 },
        );

        expect(mutation.mock.calls[0]?.[2]).toMatchObject({ replayBaseline: 10 });
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

/**
 * The outbox's replay is two public client calls — the identity verdict, then
 * the send — and a token change between them must not put a write judged as one
 * user's on another user's bearer: a bearer request carries no `expectSubject`
 * for the worker to refuse it on. Driven through a real `LunoraClient` over a
 * fake transport, because the defect lives in what the request actually carries.
 */
describe("durable outbox replay credential", () => {
    const RPC_URL = "https://app.example/_lunora/rpc";

    const clients: LunoraClient[] = [];

    /** A real client whose `/rpc` answers come from `respond`; every RPC's function path and bearer is recorded. */
    const realClient = (respond: (authorization: string | undefined) => Response) => {
        const requests: { authorization: string | undefined; functionPath: string }[] = [];
        const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
            if (input !== RPC_URL) {
                return new Response("{}", { status: 404 });
            }

            const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;

            requests.push({ authorization, functionPath: (JSON.parse(init?.body as string) as { functionPath: string }).functionPath });

            return respond(authorization);
        });
        const client = new LunoraClient({ fetch: fetchMock, url: "https://app.example" });

        clients.push(client);

        return { client, requests };
    };

    const ok = (): Response => Response.json({ result: "ok" });
    const expired = (): Response => Response.json({ error: { code: "UNAUTHENTICATED", message: "token expired" } }, { status: 401 });

    /** The bearers the outbox's replays of `messages:send` went out with, in order. */
    const replayBearers = (requests: { authorization: string | undefined; functionPath: string }[]): (string | undefined)[] =>
        requests.filter((request) => request.functionPath === "messages:send").map((request) => request.authorization);

    const write = (key: string) =>
        ({ args: { text: key }, clientId: "c1", functionPath: "messages:send", idempotencyKey: key, identity: "subj:user-a", mutationId: 1 }) as never;

    const startOutbox = async (client: LunoraClient, options?: Parameters<typeof defineCollections>[2]) => {
        const database = defineCollections(client, {}, options);

        executors.push(database.executor);
        await database.executor.waitForInit();

        return { database, sink: createExecutorOutboxSink(database.executor) };
    };

    /** Run `between` once, right after the next identity verdict and before the replay it gates is sent. */
    const betweenVerdictAndSend = (client: LunoraClient, between: () => void): void => {
        const verdict = client.replayIdentityVerdict.bind(client);

        vi.spyOn(client, "replayIdentityVerdict").mockImplementationOnce((stamped) => {
            const judged = verdict(stamped);

            between();

            return judged;
        });
    };

    beforeEach(() => {
        vi.stubGlobal("localStorage", memoryLocalStorage());
        vi.stubGlobal("window", globalThis);
        vi.stubGlobal("navigator", { locks: memoryWebLocks() });
    });

    afterEach(() => {
        for (const executor of executors.splice(0)) {
            executor.dispose();
        }

        for (const client of clients.splice(0)) {
            client.close();
        }

        vi.unstubAllGlobals();
    });

    it("sends the replay with the token its verdict judged, re-judges the next one, and leaves normal mutations on the live token", async () => {
        const { client, requests } = realClient(ok);
        const rejected = vi.fn<(event: WriteRejectedEvent) => void>();
        let normal: Promise<unknown> | undefined;

        client.setAuthToken("token-a", "user-a");

        // User B signs in after A's first write was judged, and fires a normal
        // mutation of their own while that replay is still in flight.
        betweenVerdictAndSend(client, () => {
            client.setAuthToken("token-b", "user-b");
            normal = client.mutation({ __lunoraRef: "notes:touch" }, {});
        });

        const { database, sink } = await startOutbox(client, { onWriteRejected: rejected });

        await sink.enqueue(write("c1:1"));
        await sink.enqueue(write("c1:2"));

        await vi.waitFor(() => {
            expect(rejected).toHaveBeenCalledTimes(1);
            expect(database.pendingCount()).toBe(0);
        });
        await normal;

        // A's first write went out once, on A's bearer; A's second was judged
        // under B, dropped, and never sent at all.
        expect(replayBearers(requests)).toStrictEqual(["Bearer token-a"]);
        expect(rejected).toHaveBeenCalledTimes(1);
        // B's own write is not pinned to anything: it rides the live token.
        expect(requests.filter((request) => request.functionPath === "notes:touch").map((request) => request.authorization)).toStrictEqual(["Bearer token-b"]);
    });

    it("holds a replay refused for an expired token, notifies once, and re-sends it under the refreshed one", async () => {
        const { client, requests } = realClient((authorization) => (authorization === "Bearer token-a" ? expired() : ok()));
        const rejected = vi.fn<(event: WriteRejectedEvent) => void>();
        // The app refreshes the same user's token when told the old one expired.
        const onExpired = vi.fn<() => void>(() => {
            client.setAuthToken("token-a2", "user-a");
        });

        client.setAuthToken("token-a", "user-a");
        client.onTokenExpired(onExpired);

        const { database, sink } = await startOutbox(client, { onWriteRejected: rejected });

        await sink.enqueue(write("c1:1"));

        await vi.waitFor(
            () => {
                expect(replayBearers(requests)).toHaveLength(2);
                expect(database.pendingCount()).toBe(0);
            },
            { timeout: 8000 },
        );

        expect(replayBearers(requests)).toStrictEqual(["Bearer token-a", "Bearer token-a2"]);
        expect(onExpired).toHaveBeenCalledTimes(1);
        expect(rejected).not.toHaveBeenCalled();
    }, 10_000);

    it("does not report a refusal of a token the app already replaced, and re-sends under the current one", async () => {
        const { client, requests } = realClient((authorization) => (authorization === "Bearer token-a" ? expired() : ok()));
        const rejected = vi.fn<(event: WriteRejectedEvent) => void>();
        const onExpired = vi.fn<() => void>();

        client.setAuthToken("token-a", "user-a");
        client.onTokenExpired(onExpired);

        // A same-user refresh lands after the verdict: the replay still goes out
        // on the token it was judged under, and that token's 401 is stale news.
        betweenVerdictAndSend(client, () => {
            client.setAuthToken("token-a2", "user-a");
        });

        const { database, sink } = await startOutbox(client, { onWriteRejected: rejected });

        await sink.enqueue(write("c1:1"));

        await vi.waitFor(
            () => {
                expect(replayBearers(requests)).toHaveLength(2);
                expect(database.pendingCount()).toBe(0);
            },
            { timeout: 8000 },
        );

        expect(replayBearers(requests)).toStrictEqual(["Bearer token-a", "Bearer token-a2"]);
        expect(onExpired).not.toHaveBeenCalled();
        expect(rejected).not.toHaveBeenCalled();
    }, 10_000);
});
