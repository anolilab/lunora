import { LunoraError } from "@lunora/errors";
import type { OfflineExecutor } from "@tanstack/offline-transactions";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defineCollections } from "../src";

/** A fake `FunctionReference` — `defineCollections` only forwards it to the client. */
const ref = (name: string) => ({ __lunoraRef: name }) as never;

const usersList = ref("users:list");
const messagesList = ref("messages:list");
const messagesSend = ref("messages:send");

interface SubscribeCall {
    args: { channelId?: string };
    cb: (rows: unknown[]) => void;
    onError?: (error: { code?: string; message: string }) => void;
    ref: unknown;
    unsubscribe: ReturnType<typeof vi.fn>;
}

/** A mock `LunoraClient` recording every `subscribe`, with a configurable `mutation`. */
const makeClient = (mutation: () => Promise<unknown> = async () => "server-id") => {
    const subscribes: SubscribeCall[] = [];
    const mutationMock = vi.fn<(reference: unknown, args: Record<string, unknown>, options?: { mutationId?: string }) => Promise<unknown>>(mutation);
    const client = {
        // The list-path row callback advances the checkpoint registry from this
        // (server-confirmed custom-mutator watermark); no custom mutators here → 0.
        confirmedMutationWatermark: () => 0,
        currentIdentity: () => null,
        mutation: mutationMock,
        // Mirrors `LunoraClient.replayIdentityVerdict`. Both stamp and current are
        // the signed-out sentinel here, so every replay is a "match".
        replayIdentityVerdict: (stamped: null | string | undefined) => (stamped === null ? "match" : "mismatch"),
        subscribe: vi.fn<
            (
                reference: unknown,
                args: { channelId?: string },
                cb: (rows: unknown[]) => void,
                options?: { onError?: (error: { code?: string; message: string }) => void },
            ) => () => void
        >((reference, args, cb, options) => {
            const unsubscribe = vi.fn<() => void>();

            subscribes.push({ args, cb, onError: options?.onError, ref: reference, unsubscribe });

            return unsubscribe;
        }),
    };

    return { client: client as never, mutation: mutationMock, subscribes };
};

// The slice of the returned data layer this test reads (the public types are
// inferred from the binding; here we only need a structural view).
interface TestCollection {
    get: (key: string) => Record<string, unknown> | undefined;
    size: number;
    subscribeChanges: (cb: () => void) => { unsubscribe: () => void };
}
interface TestDb {
    actions: { messages: (input: { channelId: string; text: string }) => { id: string } };
    collections: { messages: TestCollection; users: TestCollection };
    executor: OfflineExecutor;
    scope: { messages: (args?: { channelId: string }) => void };
}

const executors: OfflineExecutor[] = [];

const build = (client: never): TestDb => {
    const database = defineCollections(client, {
        messages: {
            insert: {
                mutation: messagesSend,
                optimistic: (input: { channelId: string; text: string }, id) => {
                    return { _creationTime: 0, _id: id, channelId: input.channelId, text: input.text };
                },
                toArgs: (row) => {
                    return { channelId: row.channelId, id: row._id, text: row.text };
                },
            },
            list: messagesList,
            scopeBy: "channelId",
        },
        users: { list: usersList },
    }) as unknown as TestDb;

    executors.push(database.executor);

    return database;
};

/** Let a microtask (collection sync / optimistic apply) flush. */
const flush = () =>
    new Promise((resolve) => {
        setTimeout(resolve, 0);
    });

describe(defineCollections, () => {
    afterEach(() => {
        for (const executor of executors.splice(0)) {
            executor.dispose();
        }
    });

    it("subscribes a static collection to its list query and syncs the rows in", async () => {
        const { client, subscribes } = makeClient();
        const database = build(client);

        const subscription = database.collections.users.subscribeChanges(() => {});
        await flush();

        const call = subscribes.find((s) => s.ref === usersList);

        expect(call).toBeDefined();
        expect(call?.args).toStrictEqual({});

        // Server snapshot arrives → the collection reflects it.
        call?.cb([
            { _id: "u1", name: "Ann" },
            { _id: "u2", name: "Bob" },
        ]);
        await flush();

        expect(database.collections.users.size).toBe(2);
        expect(database.collections.users.get("u1")).toMatchObject({ name: "Ann" });

        subscription.unsubscribe();
    });

    it("leaves a scoped collection unsubscribed until scope(), then re-points and detaches", async () => {
        const { client, subscribes } = makeClient();
        const database = build(client);
        const messagesOf = (channelId: string) => subscribes.find((s) => s.ref === messagesList && s.args.channelId === channelId);

        database.collections.messages.subscribeChanges(() => {});
        await flush();

        // Scoped: nothing subscribed yet.
        expect(subscribes.filter((s) => s.ref === messagesList)).toHaveLength(0);

        database.scope.messages({ channelId: "c1" });

        expect(messagesOf("c1")).toBeDefined();

        // Re-point: the previous subscription is torn down, the new one opened.
        database.scope.messages({ channelId: "c2" });

        expect(messagesOf("c1")?.unsubscribe).toHaveBeenCalledTimes(1);
        expect(messagesOf("c2")).toBeDefined();

        // Detach: the current subscription is torn down.
        database.scope.messages();

        expect(messagesOf("c2")?.unsubscribe).toHaveBeenCalledTimes(1);
    });

    it("optimistically inserts an action's row into its collection", async () => {
        // Keep the send in-flight so the optimistic row isn't superseded/settled
        // before we assert (on settle, with no synced row to supersede it, the
        // optimistic entry would drop — that reconcile-on-ack path is covered e2e).
        const { client } = makeClient(
            () =>
                new Promise(() => {
                    /* never settles */
                }),
        );
        const database = build(client);

        database.collections.messages.subscribeChanges(() => {});
        database.scope.messages({ channelId: "c1" });
        await database.executor.waitForInit();
        await flush();

        const { id } = database.actions.messages({ channelId: "c1", text: "hi" });
        await flush();

        expect(database.collections.messages.get(id)).toMatchObject({ channelId: "c1", text: "hi" });
    });

    it("replaces synced rows when re-pointing a scoped collection and clears them on detach", async () => {
        const { client, subscribes } = makeClient();
        const database = build(client);
        const messagesOf = (channelId: string) => subscribes.find((s) => s.ref === messagesList && s.args.channelId === channelId);

        database.collections.messages.subscribeChanges(() => {});
        await flush();

        // Sync the first channel's rows in.
        database.scope.messages({ channelId: "c1" });
        messagesOf("c1")?.cb([{ _creationTime: 0, _id: "m1", channelId: "c1", text: "from c1" }]);
        await flush();

        expect(database.collections.messages.size).toBe(1);
        expect(database.collections.messages.get("m1")).toMatchObject({ text: "from c1" });

        // Re-point: the old channel's rows are diffed out, the new channel's in.
        database.scope.messages({ channelId: "c2" });
        messagesOf("c2")?.cb([{ _creationTime: 0, _id: "m2", channelId: "c2", text: "from c2" }]);
        await flush();

        expect(database.collections.messages.get("m1")).toBeUndefined();
        expect(database.collections.messages.get("m2")).toMatchObject({ text: "from c2" });
        expect(database.collections.messages.size).toBe(1);

        // Detach: the synced rows are cleared.
        database.scope.messages();
        await flush();

        expect(database.collections.messages.size).toBe(0);
    });

    it("forwards the client-generated id to the mutation as the clientId (idempotency key)", async () => {
        const { client, mutation } = makeClient();
        const database = build(client);

        database.collections.messages.subscribeChanges(() => {});
        database.scope.messages({ channelId: "c1" });
        await database.executor.waitForInit();
        await flush();

        const { id } = database.actions.messages({ channelId: "c1", text: "hi" });

        // Let the outbox drain the queued write.
        await vi.waitFor(() => {
            expect(mutation).toHaveBeenCalledTimes(1);
        });

        // `toArgs` maps the optimistic row's `_id` onto the mutation's `id` arg, so
        // a retry replays the same clientId and the server can dedupe it — and the
        // write also carries a stable `mutationId` (the executor's idempotency key)
        // so the server dedupes a committed-but-unacked retry at the transport
        // layer, not only by the app's manual `id`-arg dedup.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- test fixture id from a mocked runtime
        expect(mutation).toHaveBeenCalledWith(messagesSend, { channelId: "c1", id, text: "hi" }, { mutationId: expect.any(String) });
    });

    it("passes a stable idempotency key on the insert replay so a retry dedupes", async () => {
        expect.hasAssertions();

        const { client, mutation } = makeClient();
        const database = build(client);

        database.collections.messages.subscribeChanges(() => {});
        database.scope.messages({ channelId: "c1" });
        await database.executor.waitForInit();
        await flush();

        database.actions.messages({ channelId: "c1", text: "hi" });

        await vi.waitFor(() => {
            expect(mutation).toHaveBeenCalledTimes(1);
        });

        // The write carries an explicit `mutationId` — the executor's stable
        // idempotency key, NOT a fresh id minted per call — so a committed-but-
        // unacked write the outbox retries resends the same `x-lunora-mutation-id`
        // and the server dedupes it instead of inserting the row twice.
        const options = mutation.mock.calls[0]?.[2];

        expect(options?.mutationId).toBeTypeOf("string");
        expect((options?.mutationId ?? "").length).toBeGreaterThan(0);
    });

    it("reports a permanently-rejected write on onWriteRejected (fire-and-forget safe)", async () => {
        // The server rejects the write with a coded application error — a
        // permanent verdict the outbox surfaces as a NonRetriableError.
        const coded = new LunoraError("CONFLICT", "duplicate name");
        const { client } = makeClient(async () => {
            throw coded;
        });
        const onWriteRejected = vi.fn<(event: { code?: string; collection: string; error: Error; row?: { _id: string } }) => void>();

        const database = defineCollections(
            client,
            {
                messages: {
                    insert: {
                        mutation: messagesSend,
                        optimistic: (input: { channelId: string; text: string }, id) => {
                            return { _creationTime: 0, _id: id, channelId: input.channelId, text: input.text };
                        },
                        toArgs: (row) => {
                            return { channelId: row.channelId, id: row._id, text: row.text };
                        },
                    },
                    list: messagesList,
                    scopeBy: "channelId",
                },
            },
            { onWriteRejected },
        ) as unknown as TestDb & { actions: { messages: (input: { channelId: string; text: string }) => { id: string } } };

        executors.push(database.executor);

        database.collections.messages.subscribeChanges(() => {});
        database.scope.messages({ channelId: "c1" });
        await database.executor.waitForInit();
        await flush();

        // Fire-and-forget: we never retain the returned transaction.
        const { id } = database.actions.messages({ channelId: "c1", text: "dupe" });

        await vi.waitFor(() => {
            expect(onWriteRejected).toHaveBeenCalledTimes(1);
        });

        const event = onWriteRejected.mock.calls[0]![0];

        expect(event.collection).toBe("messages");
        expect(event.row?._id).toBe(id);
        expect(event.error.message).toContain("duplicate name");

        // The optimistic row was rolled back once the verdict landed.
        await vi.waitFor(() => {
            expect(database.collections.messages.get(id)).toBeUndefined();
        });
    });

    it("surfaces a failed subscription via onError and does not leave the collection stuck loading", async () => {
        const { client, subscribes } = makeClient();
        const onError = vi.fn<(error: { code?: string; message: string }) => void>();

        const database = defineCollections(client, {
            users: { list: usersList, onError },
        }) as unknown as { collections: { users: TestCollection & { status: string } }; executor: OfflineExecutor };

        executors.push(database.executor);

        database.collections.users.subscribeChanges(() => {});
        await flush();

        // The static subscription must be opened with an onError handler.
        const call = subscribes.find((s) => s.ref === usersList);

        expect(call).toBeDefined();
        expect(call?.onError).toBeTypeOf("function");
        expect(database.collections.users.status).toBe("loading");

        // The server rejects the subscription.
        call?.onError?.({ code: "forbidden", message: "denied" });
        await flush();

        // The user's onError fired and the collection left `loading` (not stuck).
        expect(onError).toHaveBeenCalledWith({ code: "forbidden", message: "denied" });
        expect(database.collections.users.status).not.toBe("loading");
    });

    it("mints an action id in a non-secure context (crypto.randomUUID unavailable)", async () => {
        expect.hasAssertions();

        // Simulate a plain-HTTP dev/LAN origin: `crypto.randomUUID` is gated
        // (undefined) but `crypto.getRandomValues` still works, so `safeRandomUUID`
        // must fall back. A bare `crypto.randomUUID()` here would throw and break
        // every `db.actions.*` call.
        // eslint-disable-next-line n/no-unsupported-features/node-builtins -- test stubs globalThis.crypto to exercise the non-secure-context fallback
        const realCrypto = globalThis.crypto;
        const nonSecureCrypto = new Proxy(realCrypto, {
            get(target, property) {
                if (property === "randomUUID") {
                    return undefined;
                }

                const value = Reflect.get(target, property) as unknown;

                // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- Reflect.get over a stubbed crypto proxy
                return typeof value === "function" ? value.bind(target) : value;
            },
        });

        vi.stubGlobal("crypto", nonSecureCrypto);

        try {
            // Keep the send in-flight so the optimistic row isn't settled away.
            const { client } = makeClient(
                () =>
                    new Promise(() => {
                        /* never settles */
                    }),
            );
            const database = build(client);

            database.collections.messages.subscribeChanges(() => {});
            database.scope.messages({ channelId: "c1" });
            await database.executor.waitForInit();
            await flush();

            const { id } = database.actions.messages({ channelId: "c1", text: "hi" });
            await flush();

            expect(id).toBeTypeOf("string");
            expect(id.length).toBeGreaterThan(0);
            expect(database.collections.messages.get(id)).toMatchObject({ channelId: "c1", text: "hi" });
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("warns once when a table is bound by a second defineCollections call on the same client", () => {
        const { client } = makeClient();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        try {
            const first = defineCollections(client, { users: { list: usersList } } as never);
            executors.push(first.executor);

            // A disjoint table on the same client is legitimate — no warning.
            const disjoint = defineCollections(client, { messages: { list: messagesList } } as never);
            executors.push(disjoint.executor);

            expect(warn).not.toHaveBeenCalled();

            // Re-binding `users` on the same client mints a second live copy.
            const duplicate = defineCollections(client, { users: { list: usersList } } as never);
            executors.push(duplicate.executor);

            expect(warn).toHaveBeenCalledTimes(1);
            expect(String(warn.mock.calls[0]?.[0])).toContain("users");
        } finally {
            warn.mockRestore();
        }
    });
});
