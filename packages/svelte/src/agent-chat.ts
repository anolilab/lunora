import type { FunctionReference, LunoraClient } from "@lunora/client";
import type { Readable } from "svelte/store";
import { readable, writable } from "svelte/store";

import type { AgentThreadRecord, AgentThreadStatus } from "./agent";
import { isClient, NO_MUTATION_REF } from "./agent";
import { getLunoraClient } from "./context";
import { mutation } from "./mutation";

/**
 * One persisted (or optimistic) thread message, as `agents:agentMessages`
 * surfaces it. Client-safe mirror of `@lunora/agent`'s `AgentMessageRow` —
 * re-declared here (rather than imported) so this Svelte entry never pulls in the
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
 * The `agents.*` reference surface the chat handle reads. A structural subset of
 * the generated `api.agents`, so the whole generated `api` object is assignable.
 */
interface AgentChatApi {
    agents: {
        agentMessages: AgentMessagesReference;
        agentResolveApproval: AgentApprovalReference;
        agentThread: AgentThreadReference;
    };
}

interface AgentChatOptions {
    /** The generated `api` — its `agents.*` surface provides history, thread state, and approval resolution. */
    api: AgentChatApi;

    /**
     * Optional app mutation over the agent's cancel path
     * (`ctx.agents[name].cancel(id)`). Called with `{ instanceId, threadKey }`.
     * When omitted (or no run is in flight) {@link AgentChatHandle.cancel} is a
     * no-op.
     */
    cancel?: FunctionReference<"mutation">;
    /** History depth forwarded to `agents:agentMessages`. */
    limit?: number;

    /**
     * The app mutation that starts (or continues) a run — a thin wrapper over
     * `ctx.agents[name].run(...)`. Called with `{ threadKey, input }` merged with
     * {@link AgentChatOptions.sendArgs} and the per-call args.
     */
    send: FunctionReference<"mutation">;
    /** Extra args merged into every `send` call (e.g. an `owner` or `title`). */
    sendArgs?: Record<string, unknown>;
    /** The thread to observe and continue. */
    threadKey: string;
}

interface AgentChatHandle {
    /** Approve a paused human-in-the-loop tool call (optionally with a note). */
    approve: (toolCallId: string, note?: string) => Promise<void>;

    /**
     * Terminate the in-flight run and mark its thread `"cancelled"`. Resolves as a
     * no-op when no `cancel` mutation was supplied or no run is in flight.
     */
    cancel: () => Promise<void>;
    /** Durable thread history (oldest first) plus any un-acknowledged optimistic user turns. Read with `$messages`. */
    messages: Readable<ReadonlyArray<AgentChatMessage>>;
    /** Reject a paused human-in-the-loop tool call (optionally with a reason). */
    reject: (toolCallId: string, note?: string) => Promise<void>;
    /** Start (or continue) a run with a user message; extra args merge over `sendArgs`. Appends an optimistic user turn. */
    send: (input: string, args?: Record<string, unknown>) => Promise<void>;
    /** The live thread status, or `undefined` before the thread exists. Read with `$status`. */
    status: Readable<AgentThreadStatus | undefined>;

    /**
     * The in-flight turn's streamed text. `@lunora/svelte` ships no token-stream
     * primitive (unlike `@lunora/react`'s `useStream`), so this stays `""` and the
     * UI updates message-by-message from durable history — message-level liveness.
     * See the package followups for the token-stream gap.
     */
    streamingText: Readable<string>;

    /**
     * Stop the live history + thread subscriptions. Call in `onDestroy`
     * (`onDestroy(handle.teardown)`).
     */
    teardown: () => void;
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

const createAgentChatHandle = (client: LunoraClient, options: AgentChatOptions): AgentChatHandle => {
    const { api, cancel: cancelReference, limit, send: sendReference, sendArgs, threadKey } = options;

    const sendMutation = mutation(client, sendReference);
    const cancelMutation = mutation(client, cancelReference ?? NO_MUTATION_REF);
    const approvalMutation = mutation(client, api.agents.agentResolveApproval);

    // Latest server state kept in closures so the action closures read it
    // synchronously; the stores below drive reactive reads.
    let latestThread: AgentThreadRecord | undefined;
    let durable: ReadonlyArray<AgentChatMessage> = [];
    let optimistic: ReadonlyArray<OptimisticMessage> = [];
    // A monotonic id source for optimistic rows — handle-instance local.
    let nextId = 0;

    const messagesStore = writable<ReadonlyArray<AgentChatMessage>>([]);
    const statusStore = writable<AgentThreadStatus | undefined>();
    // No token-stream primitive on this adapter — see the type doc above.
    const streamingText = readable("");

    // Merge durable history with the optimistic user turns the server hasn't
    // acknowledged yet, and publish to the messages store.
    const recompute = (): void => {
        const visible = reconcileOptimistic(optimistic, durable);

        if (visible.length === 0) {
            messagesStore.set(durable);

            return;
        }

        messagesStore.set([
            ...durable,
            ...visible.map<AgentChatMessage>((pending, index) => {
                return {
                    content: pending.content,
                    optimistic: true,
                    role: "user",
                    seq: durable.length + index,
                };
            }),
        ]);
    };

    const historyArgs = limit === undefined ? { key: threadKey } : { key: threadKey, limit };
    const unsubscribeHistory = client.subscribe(api.agents.agentMessages, historyArgs, (value) => {
        durable = value as unknown as ReadonlyArray<AgentChatMessage>;
        recompute();
    });
    const unsubscribeThread = client.subscribe(api.agents.agentThread, { key: threadKey }, (value) => {
        latestThread = value as AgentThreadRecord | undefined;
        statusStore.set(latestThread?.status);
    });

    const send = async (input: string, arguments_?: Record<string, unknown>): Promise<void> => {
        const id = nextId;

        nextId += 1;

        // Prune already-acknowledged optimistic rows as we add the new one, so the
        // list stays bounded, then reflect it immediately.
        optimistic = [...reconcileOptimistic(optimistic, durable), { content: input, id }];
        recompute();

        await sendMutation.mutate({ input, threadKey, ...sendArgs, ...arguments_ });
    };

    const approve = async (toolCallId: string, note?: string): Promise<void> => {
        const instanceId = latestThread?.instanceId;

        if (instanceId === undefined) {
            throw new Error("agentChat: cannot approve — no in-flight run (thread has no instanceId)");
        }

        await approvalMutation.mutate({ decision: "approve", instanceId, threadKey, toolCallId, ...(note === undefined ? {} : { note }) });
    };

    const reject = async (toolCallId: string, note?: string): Promise<void> => {
        const instanceId = latestThread?.instanceId;

        if (instanceId === undefined) {
            throw new Error("agentChat: cannot reject — no in-flight run (thread has no instanceId)");
        }

        await approvalMutation.mutate({ decision: "reject", instanceId, threadKey, toolCallId, ...(note === undefined ? {} : { note }) });
    };

    const cancel = async (): Promise<void> => {
        const instanceId = latestThread?.instanceId;

        // No cancel path, or no run to cancel — nothing to terminate.
        if (cancelReference === undefined || instanceId === undefined) {
            return;
        }

        await cancelMutation.mutate({ instanceId, threadKey });
    };

    const teardown = (): void => {
        unsubscribeHistory();
        unsubscribeThread();
    };

    return {
        approve,
        cancel,
        messages: { subscribe: messagesStore.subscribe },
        reject,
        send,
        status: { subscribe: statusStore.subscribe },
        streamingText,
        teardown,
    };
};

/**
 * A first-class agent chat surface: live durable history + the send / approve /
 * reject / cancel writes, keyed by `threadKey` — the Svelte counterpart to
 * React's `useAgentChat`, re-expressed as stores you read with `$`.
 *
 * It composes the existing primitives rather than adding transport:
 * `client.subscribe(api.agents.agentMessages)` for durable history,
 * `client.subscribe(api.agents.agentThread)` for live status + the in-flight
 * `instanceId`, and {@link mutation} for the writes (`api.agents.agentResolveApproval`
 * for approvals; app-defined wrappers for `send`/`cancel`). Only the `agents:*`
 * surface is hard-coded — `send`/`cancel` stay generic references.
 *
 * A `send` optimistically appends the user turn so it renders immediately; the
 * optimistic row clears once the durable history carries the acknowledged turn.
 * The subscriptions open eagerly and run until {@link AgentChatHandle.teardown} —
 * call `onDestroy(handle.teardown)`.
 *
 * `@lunora/svelte` exposes no token-stream primitive, so {@link AgentChatHandle.streamingText}
 * stays `""` and the UI advances message-by-message from durable history
 * (message-level liveness). When a Svelte token-stream primitive lands this
 * handle can tee in-flight deltas the same way the React hook does.
 *
 * Pass `client` explicitly, or omit it to resolve the ambient client published by
 * `setLunoraClient`.
 */
export function agentChat(options: AgentChatOptions): AgentChatHandle;
export function agentChat(client: LunoraClient, options: AgentChatOptions): AgentChatHandle;
export function agentChat(clientOrOptions: AgentChatOptions | LunoraClient, maybeOptions?: AgentChatOptions): AgentChatHandle {
    const hasExplicitClient = isClient(clientOrOptions);
    const client = hasExplicitClient ? clientOrOptions : getLunoraClient();
    const options = (hasExplicitClient ? maybeOptions : clientOrOptions) as AgentChatOptions;

    return createAgentChatHandle(client, options);
}

export type { AgentChatApi, AgentChatHandle, AgentChatMessage, AgentChatOptions };
