import { useMutation, useQuery } from "@cirrus/react";
import type { FormEvent, ReactElement } from "react";
import { useState } from "react";

import { api } from "../../cirrus/_generated/api.js";
import type { Doc as Document_, Id } from "../../cirrus/_generated/dataModel.js";

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

    const channels = useQuery(api.channels.list, {}) as Document_<"channels">[] | undefined;
    const messages = useQuery(api.messages.list, activeChannel ? { channelId: activeChannel } : "skip") as Document_<"messages">[] | undefined;

    const { mutate: sendMessage, pending: sendPending } = useMutation(api.messages.send);
    const { mutate: createChannel } = useMutation(api.channels.create);

    const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
        event.preventDefault();

        if (!activeChannel || draft.trim() === "") {
            return;
        }

        await sendMessage({ channelId: activeChannel, text: draft });
        setDraft("");
    };

    const createNew = async (): Promise<void> => {
        const name = globalThis.prompt("Channel name?");

        if (!name) {
            return;
        }

        await createChannel({ name });
    };

    return (
        <div style={{ display: "grid", gap: 16, gridTemplateColumns: "240px 1fr", padding: 16 }}>
            <aside>
                <h2>Channels</h2>
                <button onClick={createNew} type="button">
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
                <form onSubmit={submit}>
                    <input
                        disabled={!activeChannel}
                        onChange={(e) => {
                            setDraft(e.target.value);
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
