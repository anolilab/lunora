import { useQuery } from "@lunora/react";
import type { JSX } from "react";

import { api } from "#lunora/_generated/api.js";
import type { Id } from "#lunora/_generated/dataModel.js";

interface ChatPaneProperties {
    /** Undefined until the project's first message creates a chat. */
    chatId: Id<"chats"> | undefined;
    projectId: string;
}

/** Human labels for the roles the transcript renders differently. */
const ROLE_LABEL: Readonly<Record<string, string>> = {
    assistant: "Builder",
    system: "System",
    tool: "Tool",
    user: "You",
};

/** One rendered turn, whichever table it came from. */
interface Turn {
    content: string;
    id: string;
    role: string;
    sortKey: number;
}

/**
 * Read one row of the agent's durable thread.
 *
 * `agents:agentMessages` is a framework query typed as a bag of unknowns (it
 * serves every app's agent), so the fields this pane renders are narrowed here
 * rather than trusted. A row with no usable text is dropped instead of rendering
 * an empty bubble.
 */
const toAgentTurn = (row: Record<string, unknown>, index: number): Turn | undefined => {
    const role = typeof row["role"] === "string" ? row["role"] : "assistant";

    // The user's own turns are already on screen from the app's `messages`
    // table; the agent thread carries a copy of each, and rendering both would
    // show every prompt twice.
    if (role === "user") {
        return undefined;
    }

    const content = typeof row["content"] === "string" ? row["content"] : "";

    if (content.length === 0) {
        return undefined;
    }

    const seq = typeof row["seq"] === "number" ? row["seq"] : index;

    return { content, id: `agent:${String(seq)}`, role, sortKey: typeof row["createdAt"] === "number" ? row["createdAt"] : Number.MAX_SAFE_INTEGER };
};

/**
 * The transcript.
 *
 * Two live subscriptions, no bespoke stream and no SSE endpoint (plan 335 §D18):
 * `chats.messages` carries the user's own turns from the app's `messages` table,
 * and `agents:agentMessages` carries the assistant and tool turns straight off
 * the durable thread the agent loop persists — which is the source of truth for
 * the generation, so the pane needs no second projection of it to stay in sync.
 */
const ChatPane = ({ chatId, projectId }: ChatPaneProperties): JSX.Element => {
    // Hooks cannot be called conditionally, so an absent chat still subscribes —
    // with `"skip"`, the framework's own way to hold a subscription slot open
    // without issuing a query. Casting a `""` into an `Id<"chats">` would have
    // compiled and then queried a row id that cannot exist.
    const transcript = useQuery(api.chats.messages, chatId === undefined ? "skip" : { chatId, projectId });

    // The thread key comes from the server rather than being rebuilt here: it is
    // the agent's addressing contract, and two spellings of it would diverge.
    const agentTurns = useQuery(api.agents.agentMessages, transcript === undefined ? "skip" : { key: transcript.threadKey });

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

    const turns: Turn[] = [
        ...transcript.messages.map((message) => {
            return { content: message.content, id: message._id, role: message.role, sortKey: message.createdAt };
        }),
        ...(agentTurns ?? []).map((row, index) => toAgentTurn(row, index)).filter((turn): turn is Turn => turn !== undefined),
    ].toSorted((left, right) => left.sortKey - right.sortKey);

    return (
        <ol className="transcript">
            {turns.map((turn) => (
                <li className={`turn turn-${turn.role}`} key={turn.id}>
                    <span className="turn-role">{ROLE_LABEL[turn.role] ?? turn.role}</span>
                    <pre className="turn-body">{turn.content}</pre>
                </li>
            ))}
        </ol>
    );
};

export { ChatPane };
