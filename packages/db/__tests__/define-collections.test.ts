/* eslint-disable no-underscore-dangle -- `_id`/`_creationTime` are Lunora document fields the fixtures mirror */
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
    ref: unknown;
    unsubscribe: ReturnType<typeof vi.fn>;
}

/** A mock `LunoraClient` recording every `subscribe`, with a configurable `mutation`. */
const makeClient = (mutation: () => Promise<unknown> = async () => "server-id") => {
    const subscribes: SubscribeCall[] = [];
    const client = {
        mutation: vi.fn(mutation),
        subscribe: vi.fn((reference: unknown, args: { channelId?: string }, cb: (rows: unknown[]) => void) => {
            const unsubscribe = vi.fn();

            subscribes.push({ args, cb, ref: reference, unsubscribe });

            return unsubscribe;
        }),
    };

    return { client: client as never, subscribes };
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

afterEach(() => {
    for (const executor of executors.splice(0)) {
        executor.dispose();
    }
});

describe(defineCollections, () => {
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
});
