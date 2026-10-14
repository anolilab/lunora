import type { DestroyRef, Signal } from "@angular/core";
import { computed } from "@angular/core";
import type { FunctionReference, LunoraClient } from "@lunora/client";

import type { AgentChatMessage, AgentLiveEvent } from "./agent";
import { resolveLunoraClient } from "./client";
import { stream } from "./stream";
import { subscription } from "./subscription";

/** The `agents:agentMessages` reference — live durable thread history. */
type AgentMessagesReference = FunctionReference<"query", { key: string; limit?: number }, ReadonlyArray<Record<string, unknown>>>;

/**
 * An app stream reference that tees the agent's in-flight live events, keyed by
 * thread. Carries token deltas and tool progress events; this primitive consumes
 * only the progress arm (`kind === "progress"`).
 */
type AgentLiveStreamReference = FunctionReference<"stream", { key: string }, AgentLiveEvent>;

/**
 * The `agents.*` reference surface the tool-events primitive reads. A structural
 * subset of the generated `api.agents`, so the whole generated `api` object is
 * assignable.
 * @experimental
 */
interface AgentToolEventsApi {
    agents: {
        agentMessages: AgentMessagesReference;
    };
}

/**
 * `AgentToolEventsOptions` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
interface AgentToolEventsOptions {
    /** The generated `api` — its `agents.agentMessages` query provides the durable tool lifecycle. */
    api: AgentToolEventsApi;

    /** Client to bind to. Defaults to the injected `LUNORA_CLIENT`. */
    client?: LunoraClient;

    /**
     * `DestroyRef` whose `onDestroy` tears the subscription + stream down. Defaults
     * to `inject(DestroyRef)` — the calling component/service.
     */
    destroyRef?: DestroyRef;
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
 * @experimental
 */
type AgentToolEvent =
    | { data: unknown; toolCallId: string; type: "progress" }
    | { input: unknown; seq: number; toolCallId: string; toolName: string; type: "call" }
    | { output: string; seq: number; status?: "approved" | "rejected"; toolCallId?: string; toolName?: string; type: "result" }
    | { seq: number; toolCallId?: string; toolName?: string; type: "awaiting-approval" };

/**
 * `AgentToolEventsResult` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
interface AgentToolEventsResult {
    /**
     * The thread's tool events: the durable lifecycle (oldest first, by `seq`)
     * followed by any in-flight ephemeral progress events, recomputed from the live
     * subscription + stream. Treat as derived, not identity-stable.
     */
    events: Signal<ReadonlyArray<AgentToolEvent>>;
}

/**
 * A placeholder stream reference so the stream primitive is called unconditionally
 * even when the caller supplies no live stream. Paired with `"skip"` args, it never
 * opens a stream.
 */
const NO_STREAM_REF: AgentLiveStreamReference = { __lunoraRef: "" };

/** Stable empty history so the un-loaded subscription doesn't churn the derived list identity. */
const EMPTY_MESSAGES: ReadonlyArray<Record<string, unknown>> = [];

/** Map one durable thread message to its tool event(s), or `undefined` if it carries none. */
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
 * without the full chat message surface. The Angular counterpart to React's
 * `useAgentToolEvents`, re-expressed as a `computed` signal.
 *
 * It composes the existing primitives rather than adding transport:
 * `subscription(api.agents.agentMessages)` for the durable lifecycle and
 * {@link stream} over the optional app event stream for ephemeral progress.
 * Progress events are live-only (the durable path never emits them): they ride the
 * same sink as token deltas and are surfaced here, correlated to their tool call by
 * `toolCallId`. For the conversational surface (messages + streaming text +
 * approvals) use `agentChat`; this primitive is the tool-observability slice.
 *
 * Call from an injection context (component/service field or constructor); pass an
 * explicit `client` / `destroyRef` to drive it outside one (e.g. in a test).
 * @experimental
 */
const agentToolEvents = (options: AgentToolEventsOptions): AgentToolEventsResult => {
    const { api, limit, stream: streamReference, threadKey } = options;

    const client = resolveLunoraClient(options.client);
    // Forward the caller's `destroyRef` verbatim (`undefined` when they are in an
    // injection context) rather than a resolved one: each child primitive then
    // injects its own and keeps its SSR platform gate, because an explicitly
    // passed `destroyRef` marks a manual-lifetime caller that drives the socket
    // itself and bypasses that gate (see `shouldOpenSubscription`).
    const { destroyRef } = options;

    const messagesArguments = limit === undefined ? { key: threadKey } : { key: threadKey, limit };
    const { data: history } = subscription(api.agents.agentMessages, messagesArguments, { client, destroyRef });

    // The event stream is optional: with no reference we pass the sentinel + "skip"
    // so the stream primitive never opens a stream (and no progress events surface).
    const streamArguments: "skip" | { key: string } = streamReference === undefined ? "skip" : { key: threadKey };
    const { chunks } = stream(streamReference ?? NO_STREAM_REF, streamArguments, { client, destroyRef });

    const events = computed<ReadonlyArray<AgentToolEvent>>(() => {
        const durable = (history() ?? EMPTY_MESSAGES) as unknown as ReadonlyArray<AgentChatMessage>;
        const derived: AgentToolEvent[] = durable.flatMap((message) => toDurableEvent(message) ?? []);

        // Append the thread's in-flight progress events after the durable
        // lifecycle. They're transient — cleared when the stream resets — so they
        // naturally trail the persisted history.
        for (const event of chunks()) {
            if (event.kind === "progress" && event.threadKey === threadKey) {
                derived.push({ data: event.data, toolCallId: event.toolCallId, type: "progress" });
            }
        }

        return derived;
    });

    return { events };
};

export type { AgentToolEvent, AgentToolEventsApi, AgentToolEventsOptions, AgentToolEventsResult };
export { agentToolEvents };
