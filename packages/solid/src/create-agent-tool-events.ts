import type { FunctionReference } from "@lunora/client";
import type { Accessor } from "solid-js";
import { createMemo } from "solid-js";

import type { MaybeAccessor } from "./create-agent";
import { resolveMaybe } from "./create-agent";
import type { AgentChatMessage } from "./create-agent-chat";
import { createSubscription } from "./create-subscription";

/** The `agents:agentMessages` reference — live durable thread history. */
type AgentMessagesReference = FunctionReference<"query", { key: string; limit?: number }, ReadonlyArray<Record<string, unknown>>>;

/**
 * The `agents.*` reference surface the tool-events primitive reads. A structural
 * subset of the generated `api.agents`, so the whole generated `api` object is
 * assignable.
 */
interface CreateAgentToolEventsApi {
    agents: {
        agentMessages: AgentMessagesReference;
    };
}

interface CreateAgentToolEventsOptions {
    /** The generated `api` — its `agents.agentMessages` query provides the durable tool lifecycle. */
    api: CreateAgentToolEventsApi;
    /** History depth forwarded to `agents:agentMessages`. */
    limit?: number;
    /** The thread whose tool activity to observe — a plain value or accessor (an accessor re-subscribes on change). */
    threadKey: MaybeAccessor<string>;
}

/**
 * A single tool-lifecycle event for a thread. The durable arms
 * (`call`/`result`/`awaiting-approval`) are derived from `agents:agentMessages`
 * and carry the persisted `seq`; the ephemeral `progress` arm — surfaced by
 * React's `useAgentToolEvents` off its `useStream` transport — has no `seq`.
 * `@lunora/solid` ships no token-stream primitive, so this adapter never emits
 * the `progress` arm today (see {@link CreateAgentToolEventsResult.events}); the
 * arm stays in the union for parity with `@lunora/react` and
 * forward-compatibility. Discriminate on `type`.
 */
type AgentToolEvent =
    | { data: unknown; toolCallId: string; type: "progress" }
    | { input: unknown; seq: number; toolCallId: string; toolName: string; type: "call" }
    | { output: string; seq: number; status?: "approved" | "rejected"; toolCallId?: string; toolName?: string; type: "result" }
    | { seq: number; toolCallId?: string; toolName?: string; type: "awaiting-approval" };

interface CreateAgentToolEventsResult {
    /**
     * The thread's tool events: the durable lifecycle (oldest first, by `seq`),
     * recomputed from the live subscription. Live `ctx.reportProgress(...)` events
     * would trail the durable lifecycle, but `@lunora/solid` exposes no
     * token-stream primitive (unlike `@lunora/react`'s `useStream`), so no
     * `progress` events are surfaced yet — the UI advances tool-call-by-tool-call
     * from durable history. See the package followups for the token-stream gap.
     */
    events: Accessor<ReadonlyArray<AgentToolEvent>>;
}

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
 * A focused view of a thread's tool activity: tool calls, their results, and
 * human-in-the-loop approval pauses — without the full chat message surface. The
 * Solid counterpart to React's `useAgentToolEvents`, re-expressed as a memo.
 *
 * It composes the existing primitive rather than adding transport:
 * `createSubscription(api.agents.agentMessages)` for the durable lifecycle.
 * React's hook also tees live `ctx.reportProgress(...)` events off its `useStream`
 * transport; `@lunora/solid` ships no token-stream primitive, so this primitive
 * surfaces the durable lifecycle only and the `progress` arm stays unused for now
 * (message-level liveness). For the conversational surface (messages + approvals)
 * use `createAgentChat`; this primitive is the tool-observability slice.
 */
const createAgentToolEvents = (options: CreateAgentToolEventsOptions): CreateAgentToolEventsResult => {
    const { api, limit, threadKey } = options;

    const messagesArguments = (): { key: string; limit?: number } => {
        const key = resolveMaybe(threadKey);

        return limit === undefined ? { key } : { key, limit };
    };
    const { data: history } = createSubscription(api.agents.agentMessages, messagesArguments);

    const events = createMemo<ReadonlyArray<AgentToolEvent>>(() => {
        const durable = (history() ?? EMPTY_MESSAGES) as unknown as ReadonlyArray<AgentChatMessage>;

        return durable.flatMap((message) => toDurableEvent(message) ?? []);
    });

    return { events };
};

export type { AgentToolEvent, CreateAgentToolEventsApi, CreateAgentToolEventsOptions, CreateAgentToolEventsResult };
export { createAgentToolEvents };
