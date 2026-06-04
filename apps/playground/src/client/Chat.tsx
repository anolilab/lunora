import { useMutation, useQuery } from "@cirrus/react";
import type { CSSProperties, ReactElement } from "react";
import { useState } from "react";

import { api } from "../../cirrus/_generated/api.js";
import type { Id } from "../../cirrus/_generated/dataModel.js";

/** Hoisted so the literal isn't reallocated (and re-flagged) per render. */
const LAYOUT_STYLE: CSSProperties = { display: "grid", gap: 16, gridTemplateColumns: "240px 1fr", padding: 16 };

/**
 * Channel list + message list demo. The `api.*` references are produced by
 * `cirrus codegen` (see `apps/playground/cirrus/_generated/api.ts`) and carry
 * the inferred args/return types so `useQuery` / `useMutation` calls are
 * fully typed end-to-end. The branded `Id&lt;"channels">` ensures the channel
 * picked from the list flows through unchanged to the message subscription.
 */
export const Chat = (): ReactElement => {
    const [activeChannel, setActiveChannel] = useState<Id<"channels"> | null>(null);
    const [draft, setDraft] = useState("");

    const channels = useQuery(api.channels.list, {});
    const messages = useQuery(api.messages.list, activeChannel ? { channelId: activeChannel } : "skip");

    const { mutate: sendMessage, pending: sendPending } = useMutation(api.messages.send);
    const { mutate: createChannel } = useMutation(api.channels.create);

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

                        void createChannel({ name });
                    }}
                    type="button"
                >
                    + New channel
                </button>
                <ul>
                    {(channels ?? []).map((channel) => (
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
                <h2>{activeChannel ?? "Select a channel"}</h2>
                <ul>
                    {(messages ?? []).map((message) => (
                        <li key={message._id}>
                            <strong>{message.userId}</strong>: {message.text}
                        </li>
                    ))}
                </ul>
                <form
                    onSubmit={(event) => {
                        event.preventDefault();

                        if (!activeChannel || draft.trim() === "") {
                            return;
                        }

                        void (async () => {
                            await sendMessage({ channelId: activeChannel, text: draft });
                            setDraft("");
                        })();
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
                    <button disabled={!activeChannel || sendPending} type="submit">
                        Send
                    </button>
                </form>
            </main>
        </div>
    );
};
