import type { CirrusClient } from "@cirrus/react";
import type { Collection, Transaction } from "@tanstack/db";
import { createCollection } from "@tanstack/db";
import type { OfflineExecutor, OnlineDetector } from "@tanstack/offline-transactions";
import { NonRetriableError, startOfflineExecutor } from "@tanstack/offline-transactions";

import { api } from "../../cirrus/_generated/api.js";
// eslint-disable-next-line unicorn/prevent-abbreviations -- "Doc" is the generated dataModel type name; aliasing it breaks codegen
import type { Doc, Id } from "../../cirrus/_generated/dataModel.js";

/** Author projection mirrored from `users.list` (id + display name only). */
export type UserRow = Pick<Doc<"users">, "_id" | "name">;

/**
 * Messages data layer, built entirely on TanStack DB + its offline-transactions
 * outbox — the maintained, tested machinery — rather than `@cirrus/client`'s
 * bespoke optimistic/offline queue.
 *
 *   - **Reads**: a `messages` collection synced from the Cirrus live subscription
 *     for the *active* channel, plus a `users` collection mirrored from D1. The UI
 *     joins and sorts them with TanStack DB's incremental live-query engine.
 *   - **Writes**: a `createOfflineAction` whose `onMutate` inserts the optimistic
 *     row and whose named `mutationFn` performs the Cirrus mutation. The executor
 *     persists each send to a durable outbox (IndexedDB) and retries it with
 *     backoff until the browser is back online — so an offline send is never lost,
 *     and is superseded by the synced server row on success (key match via the
 *     client-generated id).
 */
export interface MessagesStore {
    collection: Collection<Doc<"messages">, string>;
    executor: OfflineExecutor;
    /** Optimistically send a message; returns the client id + its transaction. */
    send: (input: { channelId: Id<"channels">; text: string; userId: Id<"users"> }) => { id: Id<"messages">; transaction: Transaction };
    /** Point the live subscription at a channel (or `null` to detach). */
    setActiveChannel: (channelId: Id<"channels"> | null) => void;
    usersCollection: Collection<UserRow, string>;
}

/** A TanStack DB sync write channel (the subset `makeDiffEmit` drives). */
interface SyncWriter<T extends object> {
    begin: () => void;
    commit: () => void;
    write: (message: { type: "insert" | "update"; value: T } | { key: string; type: "delete" }) => void;
}

/**
 * Build an `emit(next)` that diffs a desired keyed snapshot into a collection's
 * sync channel — only changed rows are written, so a reconnect or channel switch
 * never churns the synced view out from under a pending optimistic row. Tracks
 * the last-synced base in `synced`.
 */
const makeDiffEmit =
    <T extends object>(synced: Map<string, T>, writer: SyncWriter<T>) =>
    (next: Map<string, T>): void => {
        writer.begin();

        for (const [key, value] of next) {
            const previous = synced.get(key);

            if (previous === undefined) {
                writer.write({ type: "insert", value });
            } else if (JSON.stringify(previous) !== JSON.stringify(value)) {
                writer.write({ type: "update", value });
            }
        }

        for (const key of synced.keys()) {
            if (!next.has(key)) {
                writer.write({ key, type: "delete" });
            }
        }

        writer.commit();
        synced.clear();

        for (const [key, value] of next) {
            synced.set(key, value);
        }
    };

/**
 * An "always attempt" online detector. We deliberately don't trust
 * `navigator.onLine`: Playwright's `setOffline` doesn't reliably toggle it (or
 * fire `online`/`offline` events) across browsers — Firefox in particular leaves
 * it stuck, which would freeze the outbox. Instead the executor always tries the
 * send and the `mutationFn`'s network-error retry (with backoff) handles real
 * offline; the periodic tick nudges the executor to drain the outbox so a queued
 * send replays promptly once connectivity returns.
 */
const createOptimisticOnlineDetector = (): OnlineDetector => {
    let interval: ReturnType<typeof setInterval> | undefined;

    return {
        dispose: () => {
            if (interval) {
                clearInterval(interval);
            }
        },
        isOnline: () => true,
        notifyOnline: () => {
            /* no external online signal — see the comment above */
        },
        subscribe: (callback) => {
            interval = setInterval(callback, 1000);

            return () => {
                if (interval) {
                    clearInterval(interval);
                }
            };
        },
    };
};

let store: MessagesStore | undefined;

/**
 * Build the singleton messages store over a `CirrusClient`. Idempotent — the
 * first call wins, so every component shares one collection set + outbox.
 */
export const getMessagesStore = (client: CirrusClient): MessagesStore => {
    if (store) {
        return store;
    }

    // --- messages: synced for the active channel -------------------------------
    const messagesSynced = new Map<string, Doc<"messages">>();
    let emit: ((rows: Map<string, Doc<"messages">>) => void) | undefined;
    let unsubscribe: (() => void) | undefined;

    const collection = createCollection<Doc<"messages">, string>({
        getKey: (message) => message._id,
        id: "messages",
        sync: {
            sync: (writer) => {
                emit = makeDiffEmit(messagesSynced, writer);
                writer.markReady();

                return () => {
                    emit = undefined;
                };
            },
        },
    });

    // --- users: mirrored from D1 (static, app-wide) ----------------------------
    const usersSynced = new Map<string, UserRow>();

    const usersCollection = createCollection<UserRow, string>({
        getKey: (user) => user._id,
        id: "users",
        sync: {
            sync: (writer) => {
                const usersEmit = makeDiffEmit(usersSynced, writer);
                const unsub = client.subscribe(api.users.list, {}, (rows) => {
                    usersEmit(new Map(rows.map((user) => [user._id, user])));
                    writer.markReady();
                });

                return () => {
                    unsub();
                };
            },
        },
    });

    // --- writes: durable, retried outbox ---------------------------------------
    const executor = startOfflineExecutor({
        collections: { messages: collection },
        onlineDetector: createOptimisticOnlineDetector(),
        mutationFns: {
            // Runs for every queued send. A network failure (offline) is transient,
            // so it stays retryable and the outbox replays it with backoff once the
            // browser is back online. A server rejection is a verdict — rethrow it
            // as `NonRetriableError` so the executor stops and TanStack DB rolls the
            // optimistic insert back instead of looping forever.
            sendMessage: async ({ transaction }) => {
                for (const mutation of transaction.mutations) {
                    const document = mutation.modified as unknown as Doc<"messages">;

                    try {
                        // eslint-disable-next-line no-await-in-loop -- sequential keeps the outbox's FIFO ordering
                        await client.mutation(api.messages.send, {
                            channelId: document.channelId,
                            id: document._id,
                            text: document.text,
                        });
                    } catch (error) {
                        if (error instanceof TypeError) {
                            throw error;
                        }

                        throw new NonRetriableError(error instanceof Error ? error.message : String(error));
                    }
                }
            },
        },
    });

    const sendAction = executor.createOfflineAction<{ channelId: Id<"channels">; id: Id<"messages">; text: string; userId: Id<"users"> }>({
        mutationFnName: "sendMessage",
        onMutate: ({ channelId, id, text, userId }) => {
            collection.insert({
                _creationTime: Date.now(),
                _id: id,
                channelId,
                createdAt: Date.now(),
                text,
                userId,
            });
        },
    });

    const setActiveChannel = (channelId: Id<"channels"> | null): void => {
        unsubscribe?.();
        unsubscribe = undefined;
        // Clear the previous channel's rows from the synced view.
        emit?.(new Map());

        if (!channelId) {
            return;
        }

        unsubscribe = client.subscribe(api.messages.list, { channelId }, (rows) => {
            const next = new Map<string, Doc<"messages">>();

            for (const row of rows) {
                next.set(row._id, row);
            }

            emit?.(next);
        });
    };

    store = {
        collection,
        executor,
        send: ({ channelId, text, userId }) => {
            // eslint-disable-next-line n/no-unsupported-features/node-builtins -- browser client code; `crypto.randomUUID` is available in all supported browsers
            const id = crypto.randomUUID() as Id<"messages">;
            const transaction = sendAction({ channelId, id, text, userId });

            return { id, transaction };
        },
        setActiveChannel,
        usersCollection,
    };

    return store;
};
