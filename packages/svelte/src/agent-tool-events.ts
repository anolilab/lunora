import type { FunctionReference, LunoraClient } from "@lunora/client";
import type { Readable } from "svelte/store";
import { derived } from "svelte/store";

import { isClient } from "./agent";
import type { AgentChatMessage, AgentLiveEvent } from "./agent-chat";
import { getLunoraClient } from "./context";
import { stream } from "./stream";
import { subscription } from "./subscription";

/** The `agents:agentMessages` reference — live durable thread history. */
type AgentMessagesReference = FunctionReference<"query", { key: string; limit?: number }, ReadonlyArray<Record<string, unknown>>>;

/**
 * An app stream reference that tees the agent's in-flight live events, keyed by
 * thread. Carries token deltas and tool progress events; this handle consumes only
 * the progress arm (`kind === "progress"`).
 */
type AgentLiveStreamReference = FunctionReference<"stream", { key: string }, AgentLiveEvent>;

/**
 * The `agents.*` reference surface the tool-events handle reads. A structural
 * subset of the generated `api.agents`, so the whole generated `api` object is
 * assignable.
 */
interface AgentToolEventsApi {
    agents: {
        agentMessages: AgentMessagesReference;
    };
}

interface AgentToolEventsOptions {
    /** The generated `api` — its `agents.agentMessages` query provides the durable tool lifecycle. */
    api: AgentToolEventsApi;
    /** History depth forwarded to `agents:agentMessages`. */
    limit?: number;

    /**
     * Optional live event stream — the same app stream function `agentChat` uses.
     * When supplied, ephemeral `ctx.reportProgress(...)` events for the thread are
     * surfaced as `{ type: "progress" }` entries; when omitted only the durable
     * lifecycle (call / result / awaiting-approval) is returned.
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

interface AgentToolEventsHandle {
    /**
     * The thread's tool events: the durable lifecycle (oldest first, by `seq`)
     * followed by any in-flight ephemeral progress events, recomputed from the live
     * subscription + stream. Read with `$events`. With no `stream` reference only
     * the durable lifecycle is surfaced. Treat as derived, not identity-stable.
     */
    events: Readable<ReadonlyArray<AgentToolEvent>>;
}

/**
 * A placeholder stream reference so {@link stream} is opened unconditionally even
 * when the caller supplies no live stream. Paired with `"skip"` args, it never
 * opens a stream.
 */
const NO_STREAM_REF: AgentLiveStreamReference = { __lunoraRef: "" };

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
 * without the full chat message surface. The Svelte counterpart to React's
 * `useAgentToolEvents`, re-expressed as a readable store you read with `$`.
 *
 * It composes the existing primitives rather than adding transport:
 * {@link subscription} over `api.agents.agentMessages` for the durable lifecycle
 * and {@link stream} over the optional app event stream for ephemeral progress,
 * combined through `derived`. Progress events are live-only (the durable path never
 * emits them): they ride the same sink as token deltas and are surfaced here,
 * correlated to their tool call by `toolCallId`. For the conversational surface
 * (messages + streaming text + approvals) use `agentChat`; this handle is the
 * tool-observability slice.
 *
 * The underlying subscription and stream are lazy — they open when `events` gains
 * its first subscriber and tear down when the last one leaves — so there is no
 * `teardown` to call (unlike the write-bearing `agentChat`).
 *
 * Pass `client` explicitly, or omit it to resolve the ambient client published by
 * `setLunoraClient`.
 */
export function agentToolEvents(options: AgentToolEventsOptions): AgentToolEventsHandle;
export function agentToolEvents(client: LunoraClient, options: AgentToolEventsOptions): AgentToolEventsHandle;
export function agentToolEvents(clientOrOptions: AgentToolEventsOptions | LunoraClient, maybeOptions?: AgentToolEventsOptions): AgentToolEventsHandle {
    const hasExplicitClient = isClient(clientOrOptions);
    const client = hasExplicitClient ? clientOrOptions : getLunoraClient();
    const options = (hasExplicitClient ? maybeOptions : clientOrOptions) as AgentToolEventsOptions;

    const { api, limit, stream: streamReference, threadKey } = options;

    const historyArgs = limit === undefined ? { key: threadKey } : { key: threadKey, limit };
    const { data } = subscription(client, api.agents.agentMessages, historyArgs);

    // The event stream is optional: with no reference we pass the sentinel + "skip"
    // so `stream` never opens a stream (and no progress events are surfaced). The
    // `chunks` store is lazy, so combining it into `events` opens it only when
    // `events` gains a subscriber.
    const streamArguments = streamReference === undefined ? "skip" : { key: threadKey };
    const streamHandle = stream(client, streamReference ?? NO_STREAM_REF, streamArguments);

    const events = derived([data, streamHandle.chunks], ([history, liveEvents]) => {
        const durable = (history ?? []) as unknown as ReadonlyArray<AgentChatMessage>;
        const collected: AgentToolEvent[] = durable.flatMap((message) => toDurableEvent(message) ?? []);

        // Append the thread's in-flight progress events after the durable lifecycle.
        // They're transient — cleared when the stream resets — so they naturally
        // trail the persisted history.
        for (const event of liveEvents) {
            if (event.kind === "progress" && event.threadKey === threadKey) {
                collected.push({ data: event.data, toolCallId: event.toolCallId, type: "progress" });
            }
        }

        return collected;
    });

    return { events };
}

export type { AgentToolEvent, AgentToolEventsApi, AgentToolEventsHandle, AgentToolEventsOptions };
