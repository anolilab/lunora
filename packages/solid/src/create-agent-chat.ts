import type { FunctionReference } from "@lunora/client";
import type { Accessor } from "solid-js";
import { createMemo, createSignal } from "solid-js";

import type { AgentThreadRecord, AgentThreadStatus, MaybeAccessor } from "./create-agent";
import { NO_MUTATION_REF, resolveMaybe } from "./create-agent";
import { createMutation } from "./create-mutation";
import { createSubscription } from "./create-subscription";

/**
 * One persisted (or optimistic) thread message, as `agents:agentMessages`
 * surfaces it. Client-safe mirror of `@lunora/agent`'s `AgentMessageRow` —
 * re-declared here (rather than imported) so this Solid entry never pulls in the
 * server-only `@lunora/agent` module graph. Keep in sync with the
 * `agent_messages` table in `packages/agent/src/component.ts`.
 */
interface AgentChatMessage {
    content: string;
    createdAt?: number;

    /**
     * `true` for a client-side optimistic user message not yet acknowledged by
     * the server. Cleared once the durable history carries the matching user turn.
     */
    optimistic?: boolean;
    role: "assistant" | "system" | "tool" | "user";
    seq: number;
    /** Approval lifecycle marker on a human-in-the-loop tool message. */
    status?: "approved" | "awaiting_approval" | "rejected";
    toolCallId?: string;
    toolCalls?: ReadonlyArray<{ id: string; input: unknown; name: string }>;
    toolName?: string;
}

/** The `agents:agentMessages` reference — live durable thread history. */
type AgentMessagesReference = FunctionReference<"query", { key: string; limit?: number }, ReadonlyArray<Record<string, unknown>>>;

/** The `agents:agentResolveApproval` reference — resolves a human-in-the-loop tool approval. */
type AgentApprovalReference = FunctionReference<
    "mutation",
    { decision: "approve" | "reject"; instanceId: string; note?: string; threadKey: string; toolCallId: string },
    { resolved: boolean }
>;

/** The `agents:agentThread` reference — live thread status + in-flight `instanceId`. */
type AgentThreadReference = FunctionReference<"query", { key: string }, Record<string, unknown> | undefined>;

/**
 * The `agents.*` reference surface the chat primitive reads. A structural subset
 * of the generated `api.agents`, so the whole generated `api` object is
 * assignable.
 */
interface CreateAgentChatApi {
    agents: {
        agentMessages: AgentMessagesReference;
        agentResolveApproval: AgentApprovalReference;
        agentThread: AgentThreadReference;
    };
}

interface CreateAgentChatOptions {
    /** The generated `api` — its `agents.*` surface provides history, thread state, and approval resolution. */
    api: CreateAgentChatApi;

    /**
     * Optional app mutation over the agent's cancel path
     * (`ctx.agents.&lt;name>.cancel(id)`). Called with `{ instanceId, threadKey }`.
     * When omitted (or no run is in flight) {@link CreateAgentChatResult.cancel} is
     * a no-op.
     */
    cancel?: FunctionReference<"mutation">;
    /** History depth forwarded to `agents:agentMessages`. */
    limit?: number;

    /**
     * The app mutation that starts (or continues) a run — a thin wrapper over
     * `ctx.agents.&lt;name>.run(...)`. Called with `{ threadKey, input }` merged with
     * {@link CreateAgentChatOptions.sendArgs} and the per-call args.
     */
    send: FunctionReference<"mutation">;
    /** Extra args merged into every `send` call (e.g. an `owner` or `title`). */
    sendArgs?: Record<string, unknown>;
    /** The thread to observe and continue — a plain value or accessor (an accessor re-subscribes on change). */
    threadKey: MaybeAccessor<string>;
}

interface CreateAgentChatResult {
    /** Approve a paused human-in-the-loop tool call (optionally with a note). */
    approve: (toolCallId: string, note?: string) => Promise<void>;

    /**
     * Terminate the in-flight run and mark its thread `"cancelled"`. Resolves as a
     * no-op when no `cancel` mutation was supplied or no run is in flight.
     */
    cancel: () => Promise<void>;
    /** Durable thread history (oldest first) plus any un-acknowledged optimistic user turns. */
    messages: Accessor<ReadonlyArray<AgentChatMessage>>;
    /** Reject a paused human-in-the-loop tool call (optionally with a reason). */
    reject: (toolCallId: string, note?: string) => Promise<void>;
    /** Start (or continue) a run with a user message; extra args merge over `sendArgs`. Appends an optimistic user turn. */
    send: (input: string, args?: Record<string, unknown>) => Promise<void>;
    /** The live thread status, or `undefined` before the thread exists. */
    status: Accessor<AgentThreadStatus | undefined>;

    /**
     * The in-flight turn's streamed text. `@lunora/solid` ships no token-stream
     * primitive (unlike `@lunora/react`'s `useStream`), so this stays `""` and the
     * UI updates message-by-message from durable history — message-level liveness.
     * See the package followups for the token-stream gap.
     */
    streamingText: Accessor<string>;
}

/** A local optimistic user turn awaiting server acknowledgement. */
interface OptimisticMessage {
    content: string;
    id: number;
}

/**
 * Drop the optimistic user turns the durable history has now caught up on:
 * consume one durable `user` message per matching optimistic content, hiding
 * those that have been acknowledged. One-to-one consumption keeps repeated
 * identical prompts from all collapsing onto a single durable row.
 */
const reconcileOptimistic = (optimistic: ReadonlyArray<OptimisticMessage>, durable: ReadonlyArray<AgentChatMessage>): OptimisticMessage[] => {
    const pool = durable.filter((message) => message.role === "user").map((message) => message.content);

    return optimistic.filter((pending) => {
        const index = pool.indexOf(pending.content);

        if (index !== -1) {
            pool.splice(index, 1);

            return false;
        }

        return true;
    });
};

/**
 * A first-class agent chat surface: live durable history + the send / approve /
 * reject / cancel writes, keyed by `threadKey` — the Solid counterpart to React's
 * `useAgentChat`, re-expressed with signals.
 *
 * It composes the existing primitives rather than adding transport:
 * `createSubscription(api.agents.agentMessages)` for durable history,
 * `createSubscription(api.agents.agentThread)` for live status + the in-flight
 * `instanceId`, and `createMutation` for the writes (`api.agents.agentResolveApproval`
 * for approvals; app-defined wrappers for `send`/`cancel`). Only the `agents:*`
 * surface is hard-coded — `send`/`cancel` stay generic references.
 *
 * A `send` optimistically appends the user turn so it renders immediately; the
 * optimistic row clears once the durable history carries the acknowledged turn.
 *
 * `@lunora/solid` exposes no token-stream primitive, so {@link CreateAgentChatResult.streamingText}
 * stays `""` and the UI advances message-by-message from durable history
 * (message-level liveness). When a Solid token-stream primitive lands this
 * primitive can tee in-flight deltas the same way the React hook does.
 */
const createAgentChat = (options: CreateAgentChatOptions): CreateAgentChatResult => {
    const { api, cancel: cancelReference, limit, send: sendReference, sendArgs, threadKey } = options;

    const { data: history } = createSubscription(api.agents.agentMessages, () =>
        (limit === undefined ? { key: resolveMaybe(threadKey) } : { key: resolveMaybe(threadKey), limit }), );
    const { data: threadData } = createSubscription(api.agents.agentThread, () => {
        return { key: resolveMaybe(threadKey) };
    });

    const sendMutation = createMutation(sendReference);
    const cancelMutation = createMutation(cancelReference ?? NO_MUTATION_REF);
    const approvalMutation = createMutation(api.agents.agentResolveApproval);

    const [optimistic, setOptimistic] = createSignal<ReadonlyArray<OptimisticMessage>>([]);
    // A monotonic id source for optimistic rows — primitive-instance local.
    let nextId = 0;

    const thread = createMemo(() => threadData() as unknown as AgentThreadRecord | undefined);
    const status = createMemo(() => thread()?.status);

    const durable = createMemo(() => (history() ?? []) as unknown as ReadonlyArray<AgentChatMessage>);

    // Merge durable history with the optimistic user turns the server hasn't
    // acknowledged yet (reconciled purely in the memo — no effect churn).
    const messages = createMemo<ReadonlyArray<AgentChatMessage>>(() => {
        const rows = durable();
        const visible = reconcileOptimistic(optimistic(), rows);

        if (visible.length === 0) {
            return rows;
        }

        return [
            ...rows,
            ...visible.map<AgentChatMessage>((pending, index) => {
                return {
                    content: pending.content,
                    optimistic: true,
                    role: "user",
                    seq: rows.length + index,
                };
            }),
        ];
    });

    // No token-stream primitive on this adapter — see the type doc above.
    const streamingText = (): string => "";

    const send = async (input: string, arguments_?: Record<string, unknown>): Promise<void> => {
        const id = nextId;

        nextId += 1;

        // Prune already-acknowledged optimistic rows as we add the new one, so the
        // list stays bounded without a history-dependent effect.
        setOptimistic((previous) => [...reconcileOptimistic(previous, durable()), { content: input, id }]);

        await sendMutation.mutate({ input, threadKey: resolveMaybe(threadKey), ...sendArgs, ...arguments_ });
    };

    const approve = async (toolCallId: string, note?: string): Promise<void> => {
        const instanceId = thread()?.instanceId;

        if (instanceId === undefined) {
            throw new Error("createAgentChat: cannot approve — no in-flight run (thread has no instanceId)");
        }

        await approvalMutation.mutate({
            decision: "approve",
            instanceId,
            threadKey: resolveMaybe(threadKey),
            toolCallId,
            ...(note === undefined ? {} : { note }),
        });
    };

    const reject = async (toolCallId: string, note?: string): Promise<void> => {
        const instanceId = thread()?.instanceId;

        if (instanceId === undefined) {
            throw new Error("createAgentChat: cannot reject — no in-flight run (thread has no instanceId)");
        }

        await approvalMutation.mutate({
            decision: "reject",
            instanceId,
            threadKey: resolveMaybe(threadKey),
            toolCallId,
            ...(note === undefined ? {} : { note }),
        });
    };

    const cancel = async (): Promise<void> => {
        const instanceId = thread()?.instanceId;

        // No cancel path, or no run to cancel — nothing to terminate.
        if (cancelReference === undefined || instanceId === undefined) {
            return;
        }

        await cancelMutation.mutate({ instanceId, threadKey: resolveMaybe(threadKey) });
    };

    return { approve, cancel, messages, reject, send, status, streamingText };
};

export type { AgentChatMessage, CreateAgentChatApi, CreateAgentChatOptions, CreateAgentChatResult };
export { createAgentChat };
