/**
 * Optimistic-reconcile logic shared by every `@lunora/*` framework adapter's
 * agent-chat surface (`@lunora/react` `useAgentChat`, plus the `@lunora/vue`,
 * `@lunora/solid`, `@lunora/svelte`, and `@lunora/angular` counterparts). The
 * adapters keep only their framework-specific state plumbing
 * (`useState` / `.value` / `.set()` / a store) and delegate the pure merge decision
 * here, so the heuristic lives — and is tested — in exactly one place.
 */

/**
 * The durable-message shape the reconcile reads: a structural subset of each
 * adapter's `AgentChatMessage` (itself a client-safe mirror of `@lunora/agent`'s
 * `AgentMessageRow`). Only `content`, `role`, and the globally-monotonic `seq` are
 * consulted; adapters pass their fuller row type, which is assignable to this.
 */
interface ReconcileDurableMessage {
    content: string;
    role: "assistant" | "system" | "tool" | "user";
    seq: number;
}

/**
 * A local optimistic user turn awaiting server acknowledgement. `id` is a
 * client-generated handle the adapter uses to roll the row back on a failed send;
 * the reconcile itself reads only `content` and `maxDurableSeqAtSend`.
 */
interface OptimisticMessage {
    content: string;
    id: number;

    /**
     * The highest durable `seq` present when this row was sent. The reconcile
     * retires the row when a durable `user` row with matching `content` lands at a
     * STRICTLY GREATER `seq` (i.e. after the send) — window-independent because
     * `seq` is globally monotonic, not a positional count. Also the age baseline for
     * the {@link RETIRE_AFTER_DURABLE_SEQ_ADVANCE} fallback.
     */
    maxDurableSeqAtSend: number;
}

/**
 * The highest `seq` across `messages`, or `-1` when empty. Used both to capture an
 * optimistic row's `maxDurableSeqAtSend` at send time and to base the synthetic
 * seqs of rendered optimistic rows above the highest real durable seq (not just
 * `messages.length`, which under-counts when durable rows have gaps), so a
 * placeholder seq never collides with a real one.
 */
const maxSeq = (messages: ReadonlyArray<{ seq: number }>): number => {
    let max = -1;

    for (const message of messages) {
        if (message.seq > max) {
            max = message.seq;
        }
    }

    return max;
};

/**
 * Secondary, windowed fallback: retire a pending optimistic row once the durable
 * history's highest `seq` has advanced at least this far past the value seen at
 * send, even though no matching-content user row is currently visible to claim it.
 * This covers the pathological "identical content already present at send time"
 * case, where no user row with a STRICTLY GREATER `seq` than the send-time max will
 * ever appear for the primary content match to consume (e.g. the acknowledging row
 * was evicted by a bounded `limit` before reconcile could see it). `seq` is globally
 * monotonic, so it keeps climbing even when the visible user-row COUNT does not.
 *
 * The `2` is a heuristic threshold, NOT an invariant about turn shape. It is
 * tempting to read it as "one turn == a user row and an assistant row (+2)", but
 * `@lunora/agent`'s tool-loop turns can persist MANY rows, and an ERRORED turn
 * persists only the user row (+1). Those non-(+2) turns are retired by the PRIMARY
 * seq-based content match below (which sees the user row land at a greater `seq`),
 * never by this count-based fallback. The fully robust fix is a server-echoed
 * correlation id on each persisted user row (deferred — see plan 188).
 *
 * KNOWN LIMITATION (inherent to a client-only heuristic): on an ownerless /
 * `instanceId`-less thread a FOREIGN writer that advances `seq` by >= 2 between this
 * row's send and its own acknowledgement can trip this fallback and retire the row a
 * beat early. The correlation id closes that gap; until then it is the accepted
 * residual edge.
 */
const RETIRE_AFTER_DURABLE_SEQ_ADVANCE = 2;

/**
 * Drop the optimistic user turns the durable history has now caught up on. Pure —
 * it reads only the two arrays plus values captured on each pending row at send
 * time (no clock, no state mutation), so it is safe to run in render.
 *
 * The primary retire condition: a durable `user` row with the same `content` exists
 * whose `seq` is STRICTLY GREATER than the row's `maxDurableSeqAtSend` — i.e. a user
 * row that landed AFTER the send. This is window-independent (it matches on monotonic
 * `seq`, not a positional count), so it retires the normal turn AND an errored
 * single-row (+1) turn even under a saturated, sliding `limit`. Each durable row is
 * consumed at most once (the `consumed` set), so repeated identical prompts sent
 * back-to-back each wait for their OWN durable row instead of collapsing onto one.
 *
 * Failing that, the {@link RETIRE_AFTER_DURABLE_SEQ_ADVANCE} windowed fallback fires
 * (see its doc) for the "identical content already present" pathological case.
 */
const reconcileOptimistic = (optimistic: ReadonlyArray<OptimisticMessage>, durable: ReadonlyArray<ReconcileDurableMessage>): OptimisticMessage[] => {
    const durableUserRows = durable.filter((message) => message.role === "user");
    const maxDurableSeq = maxSeq(durable);
    const consumed = new Set<number>();

    return optimistic.filter((pending) => {
        // Primary: a matching-content user row that landed AFTER this send (its
        // `seq` strictly greater than the send-time max), claimed one-to-one so
        // repeated identical prompts don't collapse onto a single durable row.
        for (const [index, row] of durableUserRows.entries()) {
            if (!consumed.has(index) && row.seq > pending.maxDurableSeqAtSend && row.content === pending.content) {
                consumed.add(index);

                return false;
            }
        }

        // Secondary fallback: no strictly-greater matching row is visible (evicted
        // by a bounded `limit`, or identical content was already present at send).
        // Keep the row only while the window has moved on by less than a full turn.
        return maxDurableSeq - pending.maxDurableSeqAtSend < RETIRE_AFTER_DURABLE_SEQ_ADVANCE;
    });
};

export type { OptimisticMessage, ReconcileDurableMessage };
export { maxSeq, reconcileOptimistic, RETIRE_AFTER_DURABLE_SEQ_ADVANCE };
