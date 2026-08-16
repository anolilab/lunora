import { useQuery } from "@lunora/react";
import type { JSX } from "react";

import { api } from "#lunora/_generated/api.js";
import type { Id } from "#lunora/_generated/dataModel.js";

interface ChatPaneProperties {
    /** Undefined until the project's first message creates a chat. */
    chatId: Id<"chats"> | undefined;
    projectId: string;
}

/** Human labels for the three roles the transcript renders differently. */
const ROLE_LABEL: Readonly<Record<string, string>> = {
    assistant: "Builder",
    tool: "Tool",
    user: "You",
};

/**
 * The transcript.
 *
 * `useQuery` here is the whole streaming story (plan 335 §D18): the agent
 * appends message rows, and this subscription re-renders. There is no SSE
 * endpoint, no polling interval, and no second wire format to keep in sync with
 * the durable thread — which is the reason the plan rejected a bolt-style
 * artifact envelope.
 */
const ChatPane = ({ chatId, projectId }: ChatPaneProperties): JSX.Element => {
    // Hooks cannot be called conditionally, so an absent chat still subscribes —
    // with `"skip"`, the framework's own way to hold a subscription slot open
    // without issuing a query. Casting a `""` into an `Id<"chats">` would have
    // compiled and then queried a row id that cannot exist.
    const transcript = useQuery(api.chats.messages, chatId === undefined ? "skip" : { chatId, projectId });

    if (chatId === undefined) {
        return (
            <div className="transcript transcript-empty">
                <p className="muted">Describe what you want built. The builder reads the project, writes files, and verifies its work.</p>
            </div>
        );
    }

    if (transcript === undefined) {
        return <p className="muted">Loading the conversation…</p>;
    }

    return (
        <ol className="transcript">
            {transcript.messages.map((message) => (
                <li className={`turn turn-${message.role}`} key={message._id}>
                    <span className="turn-role">{ROLE_LABEL[message.role] ?? message.role}</span>
                    <pre className="turn-body">{message.content}</pre>
                </li>
            ))}
        </ol>
    );
};

export { ChatPane };
