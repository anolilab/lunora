import type { FunctionReference } from "@lunora/client";
import type { ComputedRef, MaybeRefOrGetter } from "vue";
import { computed, ref, toValue } from "vue";

import type { AgentThreadRecord, AgentThreadStatus } from "./use-agent";
import { NO_MUTATION_REF } from "./use-agent";
import { useMutation } from "./use-mutation";
import { useStream } from "./use-stream";
import { useSubscription } from "./use-subscription";

/**
 * One persisted (or optimistic) thread message, as `agents:agentMessages`
 * surfaces it. Client-safe mirror of `@lunora/agent`'s `AgentMessageRow` —
 * re-declared here (rather than imported) so this Vue entry never pulls in the
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

/**
 * A live token delta streamed while a turn is generating. Client-safe mirror of
 * `@lunora/agent`'s `AgentTokenDelta`. Ephemeral — deltas feed
 * {@link UseAgentChatResult.streamingText} live and are never replayed; the
 * persisted assistant message stays the single source of truth.
 */
interface AgentTokenDelta {
    /** Discriminates the token arm of {@link AgentLiveEvent}; unset on the wire (token is the default). */
    kind?: "token";
    /** The incremental text chunk the model just produced. */
    text: string;
    /** The thread this delta belongs to. */
    threadKey: string;
    /** The zero-based index of the turn producing the delta. */
    turn: number;
}

/**
 * A live tool-progress event streamed via `ctx.reportProgress(...)`. Client-safe
 * mirror of `@lunora/agent`'s `AgentProgressEvent`. Ephemeral and `toolCallId`-keyed;
 * surfaced by `useAgentToolEvents`, ignored by {@link UseAgentChatResult.streamingText}.
 */
interface AgentProgressEvent {
    /** The arbitrary, JSON-serializable payload the tool reported. */
    data: unknown;
    /** Discriminates the progress arm of {@link AgentLiveEvent}. */
    kind: "progress";
    /** The thread this event belongs to. */
    threadKey: string;
    /** The tool call this progress belongs to. */
    toolCallId: string;
}

/**
 * A single event on the agent's live-only channel — a streamed token delta or a
 * tool progress event. Client-safe mirror of `@lunora/agent`'s `AgentLiveEvent`.
 * Discriminate on `kind` (`"progress"` for the progress arm; token deltas leave
 * it unset).
 */
type AgentLiveEvent = AgentProgressEvent | AgentTokenDelta;

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
 * An app stream reference that tees the agent's in-flight live events, keyed by
 * thread. Carries token deltas and — since `ctx.reportProgress` rides the same
 * sink — tool progress events; this composable consumes only the token arm.
 */
type AgentTokenStreamReference = FunctionReference<"stream", { key: string }, AgentLiveEvent>;

/**
 * The `agents.*` reference surface the chat composable reads. A structural subset
 * of the generated `api.agents`, so the whole generated `api` object is
 * assignable.
 */
interface UseAgentChatApi {
    agents: {
        agentMessages: AgentMessagesReference;
        agentResolveApproval: AgentApprovalReference;
        agentThread: AgentThreadReference;
    };
}

interface UseAgentChatOptions {
    /** The generated `api` — its `agents.*` surface provides history, thread state, and approval resolution. */
    api: UseAgentChatApi;

    /**
     * Optional app mutation over the agent's cancel path
     * (`ctx.agents.&lt;name>.cancel(id)`). Called with `{ instanceId, threadKey }`.
     * When omitted (or no run is in flight) {@link UseAgentChatResult.cancel} is a
     * no-op.
     */
    cancel?: FunctionReference<"mutation">;
    /** History depth forwarded to `agents:agentMessages`. */
    limit?: number;

    /**
     * The app mutation that starts (or continues) a run — a thin wrapper over
     * `ctx.agents.&lt;name>.run(...)`. Called with `{ threadKey, input }` merged with
     * {@link UseAgentChatOptions.sendArgs} and the per-call args.
     */
    send: FunctionReference<"mutation">;
    /** Extra args merged into every `send` call (e.g. an `owner` or `title`). */
    sendArgs?: Record<string, unknown>;

    /**
     * Optional live token-delta stream — an app stream function that tees the
     * agent's in-flight deltas. When omitted {@link UseAgentChatResult.streamingText}
     * stays empty and the UI updates message-by-message from durable history.
     */
    stream?: AgentTokenStreamReference;
    /** The thread to observe and continue — may be a plain value, `ref`, or getter (a reactive source re-subscribes). */
    threadKey: MaybeRefOrGetter<string>;
}

interface UseAgentChatResult {
    /** Approve a paused human-in-the-loop tool call (optionally with a note). */
    approve: (toolCallId: string, note?: string) => Promise<void>;

    /**
     * Terminate the in-flight run and mark its thread `"cancelled"`. Resolves as a
     * no-op when no `cancel` mutation was supplied or no run is in flight.
     */
    cancel: () => Promise<void>;
    /** Durable thread history (oldest first) plus any un-acknowledged optimistic user turns. */
    messages: ComputedRef<ReadonlyArray<AgentChatMessage>>;
    /** Reject a paused human-in-the-loop tool call (optionally with a reason). */
    reject: (toolCallId: string, note?: string) => Promise<void>;
    /** Start (or continue) a run with a user message; extra args merge over `sendArgs`. Appends an optimistic user turn. */
    send: (input: string, args?: Record<string, unknown>) => Promise<void>;
    /** The live thread status, or `undefined` before the thread exists. */
    status: ComputedRef<AgentThreadStatus | undefined>;

    /** The in-flight turn's streamed text — live-only, empty once the turn persists to `messages`. */
    streamingText: ComputedRef<string>;
}

/** A local optimistic user turn awaiting server acknowledgement. */
interface OptimisticMessage {
    content: string;

    /**
     * Count of durable `user` rows present when this row was sent — the reconcile
     * baseline. Only a durable user row at or after this position (clamped to the
     * current count) can retire it, so a durable row that predates the send (e.g.
     * an identical earlier prompt already acknowledged) can never satisfy it.
     */
    durableUserCountAtSend: number;
    id: number;

    /**
     * The highest durable `seq` present when this row was sent — the age baseline
     * for the windowed fallback. Once the durable history advances at least
     * {@link RETIRE_AFTER_DURABLE_SEQ_ADVANCE} past it the row is retired even when
     * a bounded `limit` evicted its acknowledging turn before the positional scan
     * could match it; without this a saturated window would ghost the row forever.
     */
    maxDurableSeqAtSend: number;
}

/**
 * A placeholder stream reference so `useStream` is called unconditionally even
 * when the caller supplies no token stream. Paired with `"skip"` args, it never
 * opens a stream.
 */
const NO_STREAM_REF: AgentTokenStreamReference = { __lunoraRef: "" };

/**
 * Retire a pending optimistic row once the durable history's highest `seq` has
 * advanced at least this far past the value present when the row was sent, even
 * though positional matching never claimed it. Under a bounded `limit` a new turn
 * evicts an older row as it lands, so the durable user-row COUNT can stay flat and
 * the positional scan never fires — the optimistic row would otherwise ghost for
 * the rest of the session. `seq` is globally monotonic, so it still climbs when the
 * count does not; one acknowledged turn persists at least a user row and an
 * assistant row, so a `>= 2` advance means the window has moved on by a full turn
 * and the pending row should be retired (a late drop, never a permanent duplicate).
 * This is the client-only mitigation; the robust fix is a server-echoed correlation
 * id (see plan 188).
 */
const RETIRE_AFTER_DURABLE_SEQ_ADVANCE = 2;

/**
 * Drop the optimistic user turns the durable history has now caught up on. A
 * pending row is retired when a durable `user` row at or after the count present
 * when it was sent (clamped to the current count, so a slid or shrunk window still
 * scans a valid range) carries the same content — one-to-one consumption, lowest
 * eligible index first, keeps repeated identical prompts sent back-to-back from
 * collapsing onto a single durable row. It is also retired when the durable
 * history's highest `seq` has advanced at least
 * {@link RETIRE_AFTER_DURABLE_SEQ_ADVANCE} past the value seen at send: the windowed
 * fallback for when a bounded `limit` evicted the acknowledging row before the
 * positional scan could see it (the user-row count stayed flat).
 *
 * Pure: it reads only the two arrays plus values captured on each pending row at
 * send time — no clock, no state mutation — so it is safe to run in render.
 */
const reconcileOptimistic = (optimistic: ReadonlyArray<OptimisticMessage>, durable: ReadonlyArray<AgentChatMessage>): OptimisticMessage[] => {
    const durableUserRows = durable.filter((message) => message.role === "user");

    let maxDurableSeq = -1;

    for (const message of durable) {
        if (message.seq > maxDurableSeq) {
            maxDurableSeq = message.seq;
        }
    }

    const consumed = new Set<number>();

    return optimistic.filter((pending) => {
        for (let index = Math.min(pending.durableUserCountAtSend, durableUserRows.length); index < durableUserRows.length; index += 1) {
            const row = durableUserRows[index];

            if (row !== undefined && !consumed.has(index) && row.content === pending.content) {
                consumed.add(index);

                return false;
            }
        }

        // Windowed fallback: the acknowledging row was evicted by the bounded
        // `limit` (user-row count stayed flat), so the positional scan above can't
        // see it. `seq` still advances even when the count does not, so keep the
        // pending row only while the durable history has moved on by less than a
        // full turn; once it has caught up, retire rather than ghost.
        return maxDurableSeq - pending.maxDurableSeqAtSend < RETIRE_AFTER_DURABLE_SEQ_ADVANCE;
    });
};

/**
 * A first-class agent chat surface: live durable history + in-flight token
 * streaming + the send / approve / reject / cancel writes, keyed by `threadKey` —
 * the Vue counterpart to React's `useAgentChat`, re-expressed with refs.
 *
 * It composes the existing primitives rather than adding transport:
 * `useSubscription(api.agents.agentMessages)` for durable history,
 * `useSubscription(api.agents.agentThread)` for live status + the in-flight
 * `instanceId`, {@link useStream} over an app token stream for in-flight deltas,
 * and `useMutation` for the writes (`api.agents.agentResolveApproval` for
 * approvals; app-defined wrappers for `send`/`cancel`). Only the `agents:*`
 * surface is hard-coded — `send`/`cancel`/`stream` stay generic references.
 *
 * A `send` optimistically appends the user turn so it renders immediately; the
 * optimistic row clears once the durable history carries the acknowledged turn.
 * `streamingText` is live-only: it holds the current turn's streamed text and
 * empties as soon as that turn's assistant message lands in `messages` (the
 * persisted message is the source of truth), consistent with the loop's
 * replay-safe, live-only delta design.
 */
const useAgentChat = (options: UseAgentChatOptions): UseAgentChatResult => {
    const { api, cancel: cancelReference, limit, send: sendReference, sendArgs, stream: streamReference, threadKey } = options;

    const { data: history } = useSubscription(api.agents.agentMessages, () => {
        const key = toValue(threadKey);

        return limit === undefined ? { key } : { key, limit };
    });
    const { data: threadData } = useSubscription(api.agents.agentThread, () => {
        return { key: toValue(threadKey) };
    });

    // The token stream is optional: with no reference we pass the sentinel + "skip"
    // so `useStream` never opens a stream (and `streamingText` stays empty).
    const streamArguments: "skip" | (() => { key: string }) =
        streamReference === undefined
            ? "skip"
            : () => {
                  return { key: toValue(threadKey) };
              };
    const { chunks } = useStream(streamReference ?? NO_STREAM_REF, streamArguments);

    const sendMutation = useMutation(sendReference);
    const cancelMutation = useMutation(cancelReference ?? NO_MUTATION_REF);
    const approvalMutation = useMutation(api.agents.agentResolveApproval);

    const optimistic = ref<ReadonlyArray<OptimisticMessage>>([]);
    // A monotonic id source for optimistic rows — composable-instance local.
    let nextId = 0;

    const thread = computed(() => threadData.value as unknown as AgentThreadRecord | undefined);
    const status = computed(() => thread.value?.status);

    const durable = computed(() => (history.value ?? []) as unknown as ReadonlyArray<AgentChatMessage>);

    // Merge durable history with the optimistic user turns the server hasn't
    // acknowledged yet (reconciled purely in the computed — no watcher churn).
    const messages = computed<ReadonlyArray<AgentChatMessage>>(() => {
        const rows = durable.value;
        const visible = reconcileOptimistic(optimistic.value, rows);

        if (visible.length === 0) {
            return rows;
        }

        // Base synthetic seqs above the highest real durable seq (not just
        // `rows.length`, which can under-count when durable rows have gaps) so an
        // optimistic row's placeholder seq never collides with a real one.
        let maxDurableSeq = -1;

        for (const message of rows) {
            if (message.seq > maxDurableSeq) {
                maxDurableSeq = message.seq;
            }
        }

        return [
            ...rows,
            ...visible.map<AgentChatMessage>((pending, index) => {
                return {
                    content: pending.content,
                    optimistic: true,
                    role: "user",
                    seq: maxDurableSeq + 1 + index,
                };
            }),
        ];
    });

    // The in-flight turn is the one whose assistant message hasn't persisted yet:
    // each completed turn persists exactly one assistant row, so `turn >= <count of
    // durable assistant rows>` isolates deltas that have NOT been superseded. Once
    // the turn's message lands the count advances and its deltas fall away — the
    // persisted message becomes the source of truth. Token deltas only — progress
    // events (`kind === "progress"`) ride the same stream but carry no turn text;
    // `useAgentToolEvents` surfaces those.
    const streamingText = computed<string>(() => {
        const key = toValue(threadKey);
        const assistantCount = durable.value.filter((message) => message.role === "assistant").length;

        return chunks.value
            .filter((event): event is AgentTokenDelta => event.kind !== "progress" && event.threadKey === key && event.turn >= assistantCount)
            .map((delta) => delta.text)
            .join("");
    });

    const send = async (input: string, arguments_?: Record<string, unknown>): Promise<void> => {
        const id = nextId;

        nextId += 1;

        // Prune already-acknowledged optimistic rows as we add the new one, so the
        // list stays bounded without a history-dependent watcher.
        const durableUserCountAtSend = durable.value.filter((message) => message.role === "user").length;

        let maxDurableSeqAtSend = -1;

        for (const message of durable.value) {
            if (message.seq > maxDurableSeqAtSend) {
                maxDurableSeqAtSend = message.seq;
            }
        }

        optimistic.value = [...reconcileOptimistic(optimistic.value, durable.value), { content: input, durableUserCountAtSend, id, maxDurableSeqAtSend }];

        try {
            await sendMutation.mutate({ input, threadKey: toValue(threadKey), ...sendArgs, ...arguments_ });
        } catch (error) {
            // The mutation never landed, so no durable user turn will ever
            // reconcile this optimistic row away — drop it by id so a failed
            // send doesn't leave a permanent ghost message, then rethrow so
            // the caller can surface the failure.
            optimistic.value = optimistic.value.filter((pending) => pending.id !== id);

            throw error;
        }
    };

    const approve = async (toolCallId: string, note?: string): Promise<void> => {
        const instanceId = thread.value?.instanceId;

        if (instanceId === undefined) {
            throw new Error("useAgentChat: cannot approve — no in-flight run (thread has no instanceId)");
        }

        await approvalMutation.mutate({ decision: "approve", instanceId, threadKey: toValue(threadKey), toolCallId, ...(note === undefined ? {} : { note }) });
    };

    const reject = async (toolCallId: string, note?: string): Promise<void> => {
        const instanceId = thread.value?.instanceId;

        if (instanceId === undefined) {
            throw new Error("useAgentChat: cannot reject — no in-flight run (thread has no instanceId)");
        }

        await approvalMutation.mutate({ decision: "reject", instanceId, threadKey: toValue(threadKey), toolCallId, ...(note === undefined ? {} : { note }) });
    };

    const cancel = async (): Promise<void> => {
        const instanceId = thread.value?.instanceId;

        // No cancel path, or no run to cancel — nothing to terminate.
        if (cancelReference === undefined || instanceId === undefined) {
            return;
        }

        await cancelMutation.mutate({ instanceId, threadKey: toValue(threadKey) });
    };

    return { approve, cancel, messages, reject, send, status, streamingText };
};

export type { AgentChatMessage, AgentLiveEvent, AgentProgressEvent, AgentTokenDelta, UseAgentChatApi, UseAgentChatOptions, UseAgentChatResult };
export { useAgentChat };
