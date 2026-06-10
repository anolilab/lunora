import { useAuth, useCirrus } from "@cirrus/react";
import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import type { CSSProperties, ReactElement } from "react";
import { useEffect, useState } from "react";

import type { Id } from "../../cirrus/_generated/dataModel.js";
import { getMessagesStore } from "./messages-store.js";

/** Hoisted so the literal isn't reallocated (and re-flagged) per render. */
const LAYOUT_STYLE: CSSProperties = { display: "grid", gap: 16, gridTemplateColumns: "240px 1fr", padding: 16 };

/**
 * Channel list + message list demo.
 *
 * Messages run entirely through the TanStack DB data layer (`messages-store.ts`):
 * reads via a live-synced collection, writes via the offline-transactions outbox
 * (optimistic insert → durable, retried send → superseded by the synced server
 * row on ack). Channels stay on `useQuery` (a global read-only list).
 */
export const Chat = (): ReactElement => {
    const [activeChannel, setActiveChannel] = useState<Id<"channels"> | null>(null);
    const [draft, setDraft] = useState("");
    const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set());
    const [sync, setSync] = useState({ online: true, pending: 0 });

    const client = useCirrus();
    const { user } = useAuth();
    const store = getMessagesStore(client);

    // Surface the real outbox state: how many sends are persisted-but-unconfirmed,
    // and whether the browser is online. Polled because the executor exposes the
    // counts as getters; online transitions come through its detector.
    useEffect(() => {
        const detector = store.executor.getOnlineDetector();
        const update = (): void => {
            setSync({ online: store.executor.isOnline(), pending: store.executor.getPendingCount() });
        };

        const unsubscribe = detector.subscribe(update);
        const interval = setInterval(update, 500);

        return () => {
            unsubscribe();
            clearInterval(interval);
        };
    }, [store]);

    // Channels also run through the data layer: a live collection for reads and
    // the durable outbox for creation (optimistic, retried, offline-safe).
    const { data: channels } = useLiveQuery((q) => q.from({ channel: store.channelsCollection }), [store]);

    // Point the shared messages collection at the active channel.
    useEffect(() => {
        store.setActiveChannel(activeChannel);
    }, [store, activeChannel]);

    // Live join messages ⨝ users + chronological sort, maintained incrementally
    // by TanStack DB's query engine — author names and ordering are derived on the
    // client, no extra server round-trip.
    const { data: messages } = useLiveQuery(
        (q) =>
            q
                .from({ message: store.collection })
                .join({ author: store.usersCollection }, ({ author, message }) => eq(message.userId, author._id), "left")
                .orderBy(({ message }) => message.createdAt, "asc")
                .select(({ author, message }) => {
                    return {
                        _id: message._id,
                        text: message.text,
                        userId: message.userId,
                        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a LEFT join leaves `author` undefined for an unmatched message (e.g. an anonymous sender); TanStack DB's types don't express that nullability
                        userName: author?.name,
                    };
                }),
        [store],
    );

    const handleSend = (): void => {
        if (!activeChannel || draft.trim() === "") {
            return;
        }

        const userId = (user?.id ?? "anonymous") as Id<"users">;
        const { id, transaction } = store.send({ channelId: activeChannel, text: draft, userId });

        // Mark pending until the send's transaction settles (ack supersedes the
        // optimistic row; a server rejection rolls it back).
        setPendingIds((previous) => new Set(previous).add(id));

        const clearPending = (): void => {
            setPendingIds((previous) => {
                const next = new Set(previous);
                next.delete(id);

                return next;
            });
        };

        transaction.isPersisted.promise.finally(clearPending).catch(() => {
            // Rejection already surfaced as a rolled-back optimistic insert; the
            // `finally` cleared the pending marker, so nothing more to do here.
        });
        setDraft("");
    };

    return (
        <div style={LAYOUT_STYLE}>
            <aside>
                <h2>Channels</h2>
                <button
                    onClick={() => {
                        // eslint-disable-next-line no-alert
                        const name = globalThis.prompt("Channel name?");

                        if (!name) {
                            return;
                        }

                        store.createChannel({ createdBy: (user?.id ?? "anonymous") as Id<"users">, name });
                    }}
                    type="button"
                >
                    + New channel
                </button>
                <ul>
                    {channels.map((channel) => (
                        <li key={channel._id}>
                            <button
                                onClick={() => {
                                    setActiveChannel(channel._id);
                                }}
                                type="button"
                            >
                                {channel.name}
                            </button>
                        </li>
                    ))}
                </ul>
            </aside>
            <main>
                <h2>
                    {activeChannel ?? "Select a channel"} {!sync.online && <small data-testid="sync-status">(offline)</small>}
                    {sync.online && sync.pending > 0 && <small data-testid="sync-status">(syncing {sync.pending}…)</small>}
                </h2>
                <ul>
                    {messages.map((message) => (
                        <li key={message._id}>
                            <strong>{message.userName ?? message.userId}</strong>: {message.text}
                            {pendingIds.has(message._id) ? " (pending)" : ""}
                        </li>
                    ))}
                </ul>
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        handleSend();
                    }}
                >
                    <input
                        disabled={!activeChannel}
                        onChange={(event) => {
                            setDraft(event.target.value);
                        }}
                        placeholder="Type a message…"
                        value={draft}
                    />
                    <button disabled={!activeChannel} type="submit">
                        Send
                    </button>
                </form>
            </main>
        </div>
    );
};
