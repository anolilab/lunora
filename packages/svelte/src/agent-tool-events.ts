import type { FunctionReference, LunoraClient } from "@lunora/client";
import type { Readable } from "svelte/store";
import { derived } from "svelte/store";

import { isClient } from "./agent";
import type { AgentChatMessage } from "./agent-chat";
import { getLunoraClient } from "./context";
import { subscription } from "./subscription";

/** The `agents:agentMessages` reference — live durable thread history. */
type AgentMessagesReference = FunctionReference<"query", { key: string; limit?: number }, ReadonlyArray<Record<string, unknown>>>;

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
    /** The thread whose tool activity to observe. */
    threadKey: string;
}

/**
 * A single tool-lifecycle event for a thread. The durable arms
 * (`call`/`result`/`awaiting-approval`) are derived from `agents:agentMessages`
 * and carry the persisted `seq`; the ephemeral `progress` arm — surfaced by
 * React's `useAgentToolEvents` off its `useStream` transport — has no `seq`.
 * `@lunora/svelte` ships no token-stream primitive, so this adapter never emits
 * the `progress` arm today (see {@link AgentToolEventsHandle.events}); the arm
 * stays in the union for parity with `@lunora/react` and forward-compatibility.
 * Discriminate on `type`.
 */
type AgentToolEvent =
    | { data: unknown; toolCallId: string; type: "progress" }
    | { input: unknown; seq: number; toolCallId: string; toolName: string; type: "call" }
    | { output: string; seq: number; status?: "approved" | "rejected"; toolCallId?: string; toolName?: string; type: "result" }
    | { seq: number; toolCallId?: string; toolName?: string; type: "awaiting-approval" };

interface AgentToolEventsHandle {
    /**
     * The thread's tool events: the durable lifecycle (oldest first, by `seq`),
     * recomputed from the live subscription. Read with `$events`. Live
     * `ctx.reportProgress(...)` events would trail the durable lifecycle, but
     * `@lunora/svelte` exposes no token-stream primitive (unlike `@lunora/react`'s
     * `useStream`), so no `progress` events are surfaced yet — the UI advances
     * tool-call-by-tool-call from durable history. See the package followups for
     * the token-stream gap.
     */
    events: Readable<ReadonlyArray<AgentToolEvent>>;
}

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
 * A focused view of a thread's tool activity: tool calls, their results, and
 * human-in-the-loop approval pauses — without the full chat message surface. The
 * Svelte counterpart to React's `useAgentToolEvents`, re-expressed as a readable
 * store you read with `$`.
 *
 * It composes the existing primitive rather than adding transport:
 * {@link subscription} over `api.agents.agentMessages` for the durable lifecycle,
 * mapped through `derived`. React's hook also tees live `ctx.reportProgress(...)`
 * events off its `useStream` transport; `@lunora/svelte` ships no token-stream
 * primitive, so this handle surfaces the durable lifecycle only and the `progress`
 * arm stays unused for now (message-level liveness). For the conversational
 * surface (messages + approvals) use `agentChat`; this handle is the
 * tool-observability slice.
 *
 * The underlying subscription is lazy — it opens when `events` gains its first
 * subscriber and tears down when the last one leaves — so there is no `teardown`
 * to call (unlike the write-bearing `agentChat`).
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

    const { api, limit, threadKey } = options;

    const historyArgs = limit === undefined ? { key: threadKey } : { key: threadKey, limit };
    const { data } = subscription(client, api.agents.agentMessages, historyArgs);

    const events = derived(data, (history) => {
        const durable = (history ?? []) as unknown as ReadonlyArray<AgentChatMessage>;

        return durable.flatMap((message) => toDurableEvent(message) ?? []);
    });

    return { events };
}

export type { AgentToolEvent, AgentToolEventsApi, AgentToolEventsHandle, AgentToolEventsOptions };
