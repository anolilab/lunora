"use client";

import type { FunctionReference } from "@lunora/client";

import type { AgentChatMessage, AgentLiveEvent } from "./use-agent-chat";
import { useStream } from "./use-stream";
import useSubscription from "./use-subscription";

/** The `agents:agentMessages` reference — live durable thread history. */
type AgentMessagesReference = FunctionReference<"query", { key: string; limit?: number }, ReadonlyArray<Record<string, unknown>>>;

/**
 * An app stream reference that tees the agent's in-flight live events, keyed by
 * thread. Carries token deltas and tool progress events; this hook consumes only
 * the progress arm (`kind === "progress"`).
 */
type AgentLiveStreamReference = FunctionReference<"stream", { key: string }, AgentLiveEvent>;

/**
 * The `agents.*` reference surface the tool-events hook reads. A structural
 * subset of the generated `api.agents`, so the whole generated `api` object is
 * assignable.
 */
interface UseAgentToolEventsApi {
    agents: {
        agentMessages: AgentMessagesReference;
    };
}

interface UseAgentToolEventsOptions {
    /** The generated `api` — its `agents.agentMessages` query provides the durable tool lifecycle. */
    api: UseAgentToolEventsApi;
    /** History depth forwarded to `agents:agentMessages`. */
    limit?: number;

    /**
     * Optional live event stream — the same app stream function `useAgentChat`
     * uses. When supplied, ephemeral `ctx.reportProgress(...)` events for the
     * thread are surfaced as `{ type: "progress" }` entries; when omitted only the
     * durable lifecycle (call / result / awaiting-approval) is returned.
     */
    stream?: AgentLiveStreamReference;
    /** The thread whose tool activity to observe. */
    threadKey: string;
}

/**
 * A single tool-lifecycle event for a thread. The durable arms
 * (`call`/`result`/`awaiting-approval`) are derived from `agents:agentMessages`
 * and carry the persisted `seq`; the ephemeral `progress` arm comes live off the
 * stream and has no `seq`. Discriminate on `type`.
 */
type AgentToolEvent =
    | { data: unknown; toolCallId: string; type: "progress" }
    | { input: unknown; seq: number; toolCallId: string; toolName: string; type: "call" }
    | { output: string; seq: number; status?: "approved" | "rejected"; toolCallId?: string; toolName?: string; type: "result" }
    | { seq: number; toolCallId?: string; toolName?: string; type: "awaiting-approval" };

interface UseAgentToolEventsResult {
    /**
     * The thread's tool events: the durable lifecycle (oldest first, by `seq`)
     * followed by any in-flight ephemeral progress events. Rebuilt each render
     * from the live subscription + stream — treat as derived, not identity-stable.
     */
    events: ReadonlyArray<AgentToolEvent>;
}

/**
 * A placeholder stream reference so `useStream` is called unconditionally (Rules
 * of Hooks) even when the caller supplies no live stream. Paired with `"skip"`
 * args, it never opens a stream.
 */
const NO_STREAM_REF: AgentLiveStreamReference = { __lunoraRef: "" };

/** Stable empty history so the un-loaded subscription doesn't churn the derived list identity. */
const EMPTY_MESSAGES: ReadonlyArray<Record<string, unknown>> = [];

/** Map one durable thread message to its tool event, or `undefined` if it carries none. */
const toDurableEvent = (message: AgentChatMessage): AgentToolEvent[] | undefined => {
    // An assistant turn carries the model's tool-call requests.
    if (message.role === "assistant" && message.toolCalls) {
        return message.toolCalls.map((call) => {
            return { input: call.input, seq: message.seq, toolCallId: call.id, toolName: call.name, type: "call" };
        });
    }

    // Everything else of interest is a `tool` row — a result or an approval pause.
    if (message.role !== "tool") {
        return undefined;
    }

    if (message.status === "awaiting_approval") {
        return [
            {
                seq: message.seq,
                type: "awaiting-approval",
                ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
                ...(message.toolName === undefined ? {} : { toolName: message.toolName }),
            },
        ];
    }

    return [
        {
            output: message.content,
            seq: message.seq,
            type: "result",
            ...(message.status === "approved" || message.status === "rejected" ? { status: message.status } : {}),
            ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
            ...(message.toolName === undefined ? {} : { toolName: message.toolName }),
        },
    ];
};

/**
 * A focused view of a thread's tool activity: tool calls, their results,
 * human-in-the-loop approval pauses, and live `ctx.reportProgress(...)` events —
 * without the full chat message surface. Composes the existing primitives:
 * `useSubscription(api.agents.agentMessages)` for the durable lifecycle and
 * {@link useStream} over the optional app event stream for ephemeral progress.
 *
 * Progress events are live-only (the durable path never emits them): they ride
 * the same sink as token deltas and are surfaced here, correlated to their tool
 * call by `toolCallId`. For the conversational surface (messages + streaming
 * text + approvals) use `useAgentChat`; this hook is the tool-observability slice.
 */
const useAgentToolEvents = (options: UseAgentToolEventsOptions): UseAgentToolEventsResult => {
    const { api, limit, stream: streamReference, threadKey } = options;

    const messagesArguments = limit === undefined ? { key: threadKey } : { key: threadKey, limit };
    const { data: history } = useSubscription(api.agents.agentMessages, messagesArguments);

    // The event stream is optional: with no reference we pass the sentinel + "skip"
    // so `useStream` never opens a stream (and no progress events are surfaced).
    const streamArguments = streamReference === undefined ? "skip" : { key: threadKey };
    const { chunks } = useStream(streamReference ?? NO_STREAM_REF, streamArguments);

    const durable = (history ?? EMPTY_MESSAGES) as unknown as ReadonlyArray<AgentChatMessage>;

    const events: AgentToolEvent[] = durable.flatMap((message) => toDurableEvent(message) ?? []);

    // Append the thread's in-flight progress events after the durable lifecycle.
    // They're transient — cleared when the stream resets — so they naturally
    // trail the persisted history.
    for (const event of chunks) {
        if (event.kind === "progress" && event.threadKey === threadKey) {
            events.push({ data: event.data, toolCallId: event.toolCallId, type: "progress" });
        }
    }

    return { events };
};

export type { AgentToolEvent, UseAgentToolEventsApi, UseAgentToolEventsOptions, UseAgentToolEventsResult };
export { useAgentToolEvents };
