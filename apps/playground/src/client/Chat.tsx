import { useAuth, useLunora, useMutation, useQuery } from "@lunora/react";
import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import type { CSSProperties, ReactElement } from "react";
import { useEffect, useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import type { Id } from "../../lunora/_generated/dataModel.js";
import { clearDraft, getDraftsCollection, writeDraft } from "./drafts-store.js";
import { getMessagesStore } from "./messages-store.js";

/** Hoisted so the literal isn't reallocated (and re-flagged) per render. */
const LAYOUT_STYLE: CSSProperties = { display: "grid", gap: 16, gridTemplateColumns: "240px 1fr", padding: 16 };

/**
 * Channel list + message list demo, running entirely on the TanStack DB data
 * layer: live-synced collections for channels/messages/users, the
 * offline-transactions outbox for writes, and a client-only localStorage
 * collection for per-channel drafts (survives reload, syncs across tabs).
 */
export const Chat = (): ReactElement => {
    const [activeChannel, setActiveChannel] = useState<Id<"channels"> | null>(null);
    const [noteDraft, setNoteDraft] = useState("");
    const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set());
    const [sync, setSync] = useState({ online: true, pending: 0 });

    const drafts = getDraftsCollection();

    const client = useLunora();
    const { user } = useAuth();
    const store = getMessagesStore(client);

    // Surface the real outbox state on a single poll: how many sends are
    // persisted-but-unconfirmed (`getPendingCount`), and whether the browser is
    // online. Connectivity comes from `navigator.onLine`, NOT the executor's
    // detector — that detector is intentionally always-online (it gates retries,
    // not the UI), so reading it here would make the "(offline)" badge dead code.
    useEffect(() => {
        const update = (): void => {
            // eslint-disable-next-line n/no-unsupported-features/node-builtins -- browser client code; `navigator.onLine` is available in all supported browsers
            setSync({ online: globalThis.navigator.onLine, pending: store.executor.getPendingCount() });
        };

        const interval = setInterval(update, 500);

        return () => {
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

    // Private per-user notes — a live `useQuery` over the raw WS subscription
    // (no TanStack DB layer). The server narrows rows via the `rls()` read
    // policy in `lunora/notes.ts`; this panel exists so the auth-rls E2E can
    // prove another user's notes never reach this client, even live.
    const notes = useQuery(api.notes.list, {});
    const { mutate: addNote } = useMutation(api.notes.add);

    const handleAddNote = (): void => {
        if (noteDraft.trim() === "") {
            return;
        }

        void addNote({ createdAt: Date.now(), text: noteDraft.trim() });
        setNoteDraft("");
    };

    // The active channel's draft, read live from the localStorage collection.
    const { data: draftRows } = useLiveQuery((q) => q.from({ draft: drafts }), [drafts]);
    const draft = activeChannel ? (draftRows.find((row) => row.channelId === activeChannel)?.text ?? "") : "";

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
        clearDraft(activeChannel);
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
                <section aria-label="My notes">
                    <h2>My notes</h2>
                    <ul data-testid="notes-list">
                        {(notes ?? []).map((note) => (
                            <li key={note._id}>{note.text}</li>
                        ))}
                    </ul>
                    <form
                        onSubmit={(event) => {
                            event.preventDefault();
                            handleAddNote();
                        }}
                    >
                        <input
                            onChange={(event) => {
                                setNoteDraft(event.target.value);
                            }}
                            placeholder="Add a note…"
                            value={noteDraft}
                        />
                        <button type="submit">Add note</button>
                    </form>
                </section>
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
                            if (activeChannel) {
                                writeDraft(activeChannel, event.target.value);
                            }
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
