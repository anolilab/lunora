import { useLunora, useMutation, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import type { Doc } from "../../lunora/_generated/dataModel.js";

type Message = Doc<"messages">;
type Profile = Doc<"profiles">;

/** A tab counts as "here" if it checked in within this window… */
const PRESENCE_TTL_MS = 30_000;
/** …and every tab checks in at half that, so a live one is never briefly considered gone. */
const HEARTBEAT_MS = PRESENCE_TTL_MS / 2;

/** Non-secret correlation handle for this tab. Minted from Web Crypto, never `Math.random`. */
const newSessionId = (): string => globalThis.crypto.randomUUID();

interface ChannelProperties {
    channelId: string;
    displayName: string;
    profiles: Profile[];
    userId: string;
}

export const Channel = ({ channelId, displayName, profiles, userId }: ChannelProperties): ReactElement => {
    const client = useLunora();
    const [sessionId] = useState(newSessionId);
    const [search, setSearch] = useState("");
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Reading the clock during render is impure — it makes the same props
    // produce different output, which the React Compiler refuses to optimize
    // and which would disagree between a server render and its hydration. The
    // heartbeat below advances this instead, so the roster still ages out.
    const [now, setNow] = useState(() => Date.now());

    // Every read and write below pins `shardKey: channelId`, so it resolves to
    // this channel's Durable Object. Drop the shard key and the runtime has to
    // fan out across every channel.
    // No casts: `api.*` is generated, so these are already typed.
    const messages = useQuery(api.messages.list, { channelId }, { shardKey: channelId });
    const hits = useQuery(api.messages.search, { channelId, text: search }, { shardKey: channelId });
    const here = useQuery(api.presence.list, { channelId }, { shardKey: channelId });

    const { mutate: send } = useMutation(api.messages.send);
    const { mutate: heartbeat } = useMutation(api.presence.heartbeat);
    const { mutate: leave } = useMutation(api.presence.leave);

    useEffect(() => {
        const beat = (): void => {
            setNow(Date.now());
            void heartbeat({ channelId, name: displayName, sessionId }, { shardKey: channelId });
        };

        beat();

        const timer = globalThis.setInterval(beat, HEARTBEAT_MS);

        // `leave` says goodbye for the TAB, so it hangs off `pagehide` rather than
        // off this effect's cleanup.
        //
        // Cleanup runs on every re-run of the effect, not only when the tab goes
        // away — and under StrictMode React deliberately runs mount, cleanup, mount
        // back to back. Wired to cleanup, that issued heartbeat, leave, heartbeat as
        // three separate RPCs over `POST /_lunora/rpc`, which carries no ordering
        // guarantee between requests. Whenever the leave landed last it deleted the
        // row the second heartbeat had just written, and that member vanished from
        // the roster until the next beat 15 seconds later.
        //
        // That is what made the presence assertion in the team-chat e2e fail
        // intermittently, seeing 0 or 1 of 2 members while the messages those same
        // members had just exchanged rendered fine.
        //
        // On `pagehide` there is no remount to race. Switching channels no longer
        // sends an explicit goodbye and ages out of the old roster via
        // PRESENCE_TTL_MS instead — which is what that TTL is for, and why the
        // staleness cut already lives on the client.
        const goodbye = (): void => {
            void leave({ channelId, sessionId }, { shardKey: channelId });
        };

        globalThis.addEventListener("pagehide", goodbye);

        return () => {
            globalThis.clearInterval(timer);
            globalThis.removeEventListener("pagehide", goodbye);
        };
    }, [channelId, displayName, heartbeat, leave, sessionId]);

    // No `useMemo`: the React Compiler memoizes this derivation already.
    const byUser = new Map(profiles.map((profile) => [profile.userId, profile.name]));
    const nameOf = (id: string): string => byUser.get(id) ?? "Unknown";

    /**
     * Upload straight to R2: the action mints a signed PUT, the browser sends
     * the bytes to storage, and only the resulting key travels through the
     * mutation. The Worker never handles the file.
     */
    /** Resolve a download URL on demand — the query returns keys, not time-varying URLs. */
    const openAttachment = async (key: string): Promise<void> => {
        setError(null);

        try {
            const url = await client.action(api.messages.attachmentUrl, { channelId, key });

            globalThis.open(url, "_blank", "noreferrer");
        } catch (cause: unknown) {
            setError(cause instanceof Error ? cause.message : "could not open that attachment");
        }
    };

    /**
     * No `try` here on purpose: the submit handler below owns both the spinner
     * and the error, and the React Compiler cannot lower a `finally` (or a
     * `throw` inside a `try`) — a component containing one silently opts out of
     * optimization entirely.
     */
    const upload = async (file: File): Promise<{ key: string; name: string }> => {
        const { key, url } = await client.action(api.messages.requestAttachmentUpload, { channelId, contentType: file.type });
        const response = await fetch(url, { body: file, headers: { "content-type": file.type }, method: "PUT" });

        if (!response.ok) {
            throw new Error(`upload failed with ${String(response.status)}`);
        }

        return { key, name: file.name };
    };

    const shown = search.trim() ? (hits ?? []) : (messages ?? []);
    // The TTL is applied here rather than in the query: a live query re-runs on
    // a poke, not on a clock, so a `Date.now()` filter server-side would sit
    // stale until somebody else wrote.
    const online = (here ?? []).filter((row) => row.lastSeen >= now - PRESENCE_TTL_MS);

    return (
        <main className="channel">
            <header className="channel-header">
                <h1>#{channelId}</h1>

                <input aria-label="Search this channel" onChange={(event) => setSearch(event.target.value)} placeholder="Search" type="search" value={search} />

                <ul className="presence" aria-label="Online now">
                    {online.map((row) => (
                        <li key={row._id} title={row.name}>
                            {row.name.slice(0, 2).toUpperCase()}
                        </li>
                    ))}
                </ul>
            </header>

            {error && <p className="error">{error}</p>}

            <ol className="messages">
                {shown.map((message) => (
                    <li key={message._id}>
                        <strong>{nameOf(message.authorId)}</strong>
                        {message.authorId === userId && <span className="badge">you</span>}
                        <p>{message.content}</p>
                        {message.attachmentKey && (
                            <button
                                className="link"
                                onClick={() => {
                                    void openAttachment(message.attachmentKey as string);
                                }}
                                type="button"
                            >
                                📎 {message.attachmentName ?? "attachment"}
                            </button>
                        )}
                    </li>
                ))}

                {shown.length === 0 && <li className="muted">{search.trim() ? "No matches in this channel." : "Nothing here yet — say something."}</li>}
            </ol>

            <form
                className="composer"
                onSubmit={(event) => {
                    event.preventDefault();

                    const form = event.currentTarget;
                    const content = String(new FormData(form).get("content") ?? "");
                    const picker = form.elements.namedItem("file") as HTMLInputElement;
                    const file = picker.files?.[0];

                    if (!content.trim() && !file) {
                        return;
                    }

                    setError(null);
                    setUploading(true);

                    // Same reason as the `upload` note above: the conditional and
                    // the optional chains live in their own function so the `try`
                    // body is a single call the compiler can lower.
                    const deliver = async (): Promise<void> => {
                        const attachment = file ? await upload(file) : null;

                        await send({ attachmentKey: attachment?.key, attachmentName: attachment?.name, channelId, content }, { shardKey: channelId });
                        form.reset();
                    };

                    void (async () => {
                        try {
                            await deliver();
                        } catch (cause: unknown) {
                            // An upload can fail (size cap, rejected type) and a
                            // send can be refused. Without this the promise
                            // rejects unhandled and the composer just sits there.
                            setError(cause instanceof Error ? cause.message : "could not send that message");
                        }

                        // Deliberately after the catch rather than in a `finally`:
                        // the catch cannot throw, so both paths reach here.
                        setUploading(false);
                    })();
                }}
            >
                <input aria-label={`Message #${channelId}`} autoComplete="off" name="content" placeholder={`Message #${channelId}`} />
                <input aria-label="Attach a file" name="file" type="file" />
                <button className="primary" disabled={uploading} type="submit">
                    {uploading ? "Uploading…" : "Send"}
                </button>
            </form>
        </main>
    );
};
