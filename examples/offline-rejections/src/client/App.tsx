import { useConnectionStatus, useLunora, useMutation, useQuery } from "@lunora/react";
import type { MutationSettledEvent } from "lunorash/client";
import type { FormEvent, ReactElement } from "react";
import { useEffect, useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import type { Doc, Id } from "../../lunora/_generated/dataModel.js";

/** One row in the settled-events log fed by `client.onMutationSettled`. */
interface SettledLog {
    code?: string;
    fn: string;
    hadAwaiter: boolean;
    key: number;
    status: "committed" | "rejected";
}

/** One row in the live-error log fed by the awaited `mutate()` Promise. */
interface LiveError {
    key: number;
    message: string;
}

const shortFn = (functionPath: string): string => functionPath.split(":").at(-1) ?? functionPath;

// A stable author for this browser session — irrelevant to the demo, but `send`
// requires one.
const author = `guest-${Math.floor(Date.now() % 100_000).toString(36)}`;

/**
 * Demonstrates how Lunora surfaces a *rejected* optimistic write to the UI.
 *
 * Two channels, shown side by side:
 *
 * 1. The awaited `mutate()` Promise — works for a write sent (and rejected)
 *    while online, where the caller is still awaiting it.
 * 2. `client.onMutationSettled` — the durable channel that also fires for a
 *    write queued offline and replayed after a reload, when the original Promise
 *    is gone (`hadAwaiter: false`). That's the case a Promise alone can't cover,
 *    and where a rolled-back optimistic row would otherwise vanish silently.
 *
 * See the README for the exact offline repro steps.
 */
export const App = (): ReactElement => {
    const client = useLunora();
    const status = useConnectionStatus();

    const messages = useQuery(api.messages.list, {}) as Doc<"messages">[] | undefined;
    const { mutate: send, pending } = useMutation(api.messages.send);

    const [draft, setDraft] = useState("");
    const [settled, setSettled] = useState<SettledLog[]>([]);
    const [liveErrors, setLiveErrors] = useState<LiveError[]>([]);

    // The durable channel. Subscribe once; the unsubscribe is returned so React
    // (and StrictMode's double-invoke) cleans it up.
    useEffect(() => {
        return client.onMutationSettled((event: MutationSettledEvent) => {
            setSettled((previous) =>
                [
                    {
                        code: event.code,
                        fn: shortFn(event.functionPath),
                        hadAwaiter: event.hadAwaiter,
                        key: Date.now() + Math.random(),
                        status: event.status,
                    },
                    ...previous,
                ].slice(0, 8),
            );
        });
    }, [client]);

    const submit = async (formEvent: FormEvent<HTMLFormElement>): Promise<void> => {
        formEvent.preventDefault();

        const text = draft.trim();

        if (text === "") {
            return;
        }

        setDraft("");

        try {
            await send(
                { author, text },
                {
                    optimistic: (current) => {
                        const list = (current as Doc<"messages">[] | undefined) ?? [];
                        const provisional: Doc<"messages"> = {
                            _id: `optimistic_${Date.now()}` as Id<"messages">,
                            _creationTime: Date.now(),
                            author,
                            text,
                            createdAt: Date.now(),
                        };

                        return [provisional, ...list];
                    },
                },
            );
        } catch (error) {
            // The LIVE channel: an online rejection rejects the awaited Promise.
            // (For a write queued offline, this rejects only on reconnect-flush —
            // and not at all if you reloaded first, which is why channel 2 exists.)
            setLiveErrors((previous) =>
                [{ key: Date.now() + Math.random(), message: error instanceof Error ? error.message : String(error) }, ...previous].slice(0, 8),
            );
        }
    };

    return (
        <main style={{ maxWidth: 720, margin: "2.5rem auto", fontFamily: "system-ui", padding: "0 1rem" }}>
            <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                <h1 style={{ marginBottom: 4 }}>Rejected offline writes</h1>
                <StatusPill status={status} />
            </header>
            <p style={{ color: "#555", marginTop: 0 }}>
                Send a message containing the word <code>fail</code> — the server rejects it with a coded <code>CONFLICT</code>, and the optimistic row rolls
                back. Watch how that rejection is surfaced below. See the README for the offline / reload repro.
            </p>

            <form onSubmit={submit} style={{ display: "flex", gap: 8, margin: "16px 0" }}>
                <input
                    aria-label="Message"
                    onChange={(event) => {
                        setDraft(event.target.value);
                    }}
                    placeholder="Type a message (try one containing 'fail')"
                    style={{ flex: 1, padding: 8 }}
                    value={draft}
                />
                <button disabled={pending} type="submit">
                    Send
                </button>
            </form>

            <section style={{ display: "grid", gap: 16, gridTemplateColumns: "1fr 1fr", marginBottom: 24 }}>
                <Panel title="onMutationSettled (durable channel)" hint="Fires for every queued write — incl. post-reload replays with hadAwaiter: false.">
                    {settled.length === 0 ? (
                        <Empty>No queued writes have settled yet.</Empty>
                    ) : (
                        settled.map((entry) => (
                            <div key={entry.key} style={{ ...rowStyle, borderColor: entry.status === "rejected" ? "#e3b1b1" : "#b1e3c0" }}>
                                <strong style={{ color: entry.status === "rejected" ? "#b00020" : "#0a7d33" }}>{entry.status}</strong> <code>{entry.fn}</code>
                                {entry.code ? <code style={tagStyle}>{entry.code}</code> : null}
                                <code style={{ ...tagStyle, background: entry.hadAwaiter ? "#eef" : "#fee" }}>hadAwaiter: {String(entry.hadAwaiter)}</code>
                            </div>
                        ))
                    )}
                </Panel>

                <Panel title="awaited mutate() Promise (live channel)" hint="Only fires while a caller is awaiting — i.e. an online rejection.">
                    {liveErrors.length === 0 ? (
                        <Empty>No live rejections yet.</Empty>
                    ) : (
                        liveErrors.map((entry) => (
                            <div key={entry.key} style={{ ...rowStyle, borderColor: "#e3b1b1" }}>
                                <strong style={{ color: "#b00020" }}>rejected</strong> {entry.message}
                            </div>
                        ))
                    )}
                </Panel>
            </section>

            <h2 style={{ fontSize: "1rem" }}>Messages</h2>
            <ul style={{ listStyle: "none", padding: 0 }}>
                {(messages ?? []).map((message) => (
                    <li key={message._id} style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>
                        <span style={{ color: "#888", marginRight: 8 }}>{message.author}</span>
                        {message.text}
                    </li>
                ))}
            </ul>
        </main>
    );
};

const rowStyle = { border: "1px solid", borderRadius: 6, fontSize: 13, marginBottom: 6, padding: "6px 8px" } as const;
const tagStyle = { background: "#eee", borderRadius: 4, marginLeft: 6, padding: "1px 5px" } as const;

const StatusPill = ({ status }: { status: string }): ReactElement => {
    const connected = status === "connected";

    return (
        <span
            style={{
                background: connected ? "#e6f6ea" : "#fdeaea",
                borderRadius: 999,
                color: connected ? "#0a7d33" : "#b00020",
                fontSize: 13,
                padding: "2px 10px",
            }}
        >
            {status}
        </span>
    );
};

const Panel = ({ children, hint, title }: { children: React.ReactNode; hint: string; title: string }): ReactElement => (
    <div>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{title}</div>
        <div style={{ color: "#777", fontSize: 12, marginBottom: 8 }}>{hint}</div>
        {children}
    </div>
);

const Empty = ({ children }: { children: React.ReactNode }): ReactElement => <div style={{ color: "#999", fontSize: 13 }}>{children}</div>;
