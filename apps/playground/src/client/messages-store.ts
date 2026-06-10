import { defineCollections } from "@cirrus/db";
import type { CirrusClient } from "@cirrus/react";
import type { Collection, Transaction } from "@tanstack/db";
import type { OfflineExecutor } from "@tanstack/offline-transactions";

import { api } from "../../cirrus/_generated/api.js";
// eslint-disable-next-line unicorn/prevent-abbreviations -- "Doc" is the generated dataModel type name; aliasing it breaks codegen
import type { Doc, Id } from "../../cirrus/_generated/dataModel.js";

/** Author projection mirrored from `users.list` (id + display name only). */
export type UserRow = Pick<Doc<"users">, "_id" | "name">;

/**
 * The chat data layer — channels/messages/users live collections plus the
 * offline outbox — declared in one `defineCollections` call from `@cirrus/db`.
 * All the sync glue (snapshot diffing, scoped subscriptions, the executor, the
 * retry-vs-rollback policy, the online detector, client-id generation) lives in
 * the package; this file only names the tables and their optimistic shapes.
 */
export interface MessagesStore {
    channelsCollection: Collection<Doc<"channels">, string>;
    collection: Collection<Doc<"messages">, string>;
    /** Optimistically create a channel through the durable outbox. */
    createChannel: (input: { createdBy: Id<"users">; name: string }) => { id: string; transaction: Transaction };
    executor: OfflineExecutor;
    /** Optimistically send a message; returns the client id + its transaction. */
    send: (input: { channelId: Id<"channels">; text: string; userId: Id<"users"> }) => { id: string; transaction: Transaction };
    /** Point the live subscription at a channel (or `null` to detach). */
    setActiveChannel: (channelId: Id<"channels"> | null) => void;
    usersCollection: Collection<UserRow, string>;
}

let store: MessagesStore | undefined;

/**
 * Build the singleton chat store over a `CirrusClient`. Idempotent — the first
 * call wins, so every component shares one collection set + outbox.
 */
export const getMessagesStore = (client: CirrusClient): MessagesStore => {
    if (store) {
        return store;
    }

    const now = (): number => Date.now();

    const database = defineCollections(client, {
        channels: {
            insert: {
                mutation: api.channels.create,
                optimistic: (input: { createdBy: Id<"users">; name: string }, id) => {
                    return {
                        _creationTime: now(),
                        _id: id as Id<"channels">,
                        createdAt: now(),
                        createdBy: input.createdBy,
                        name: input.name,
                    };
                },
                toArgs: (row) => {
                    return { id: row._id, name: row.name };
                },
            },
            list: api.channels.list,
        },
        messages: {
            insert: {
                mutation: api.messages.send,
                optimistic: (input: { channelId: Id<"channels">; text: string; userId: Id<"users"> }, id) => {
                    return {
                        _creationTime: now(),
                        _id: id as Id<"messages">,
                        channelId: input.channelId,
                        createdAt: now(),
                        text: input.text,
                        userId: input.userId,
                    };
                },
                toArgs: (row) => {
                    return { channelId: row.channelId, id: row._id, text: row.text };
                },
            },
            list: api.messages.list,
            scopeBy: "channelId",
        },
        users: {
            list: api.users.list,
        },
    });

    store = {
        channelsCollection: database.collections.channels,
        collection: database.collections.messages,
        createChannel: (input) => database.actions.channels(input),
        executor: database.executor,
        send: (input) => database.actions.messages(input),
        setActiveChannel: (channelId) => {
            database.scope.messages(channelId ? { channelId } : undefined);
        },
        usersCollection: database.collections.users,
    };

    return store;
};
