/** The schema-extension key the agent tables merge under (`agent_*` physical names). */
const AGENT_EXTENSION_KEY = "agent" as const;

/**
 * Loose structural view of a registered Lunora function — wide enough for any
 * concrete `RegisteredMutation`/`RegisteredQuery` (whose precise validator-map
 * generics make them invariant), narrow enough for re-export, dispatch, and
 * tests. Codegen registers the runtime value; it never needs the generics.
 */
interface AgentRegisteredFunction {
    readonly args: unknown;
    readonly handler: (context: unknown, args: never) => unknown;
    readonly kind: "mutation" | "query";
    readonly visibility?: "internal" | "public";
}

/**
 * The longest a HITL approval wait may hibernate, however it is configured.
 *
 * A configured `approvalTimeout` is CLAMPED to this at read. The bound is not
 * cosmetic: a wait that outlives {@link ABANDONED_APPROVAL_MS} lets the thread
 * be reclaimed (its `instanceId` re-stamped) while the approval is still
 * pending, which is precisely the stranded-approval failure the timeout exists
 * to prevent. A week already exceeds any plausible human turnaround.
 */
const APPROVAL_TIMEOUT_MAX_MS: number = 7 * 24 * 60 * 60 * 1000;

/**
 * How long an `"awaiting_input"` (HITL-paused) thread may sit untouched before
 * a new run may reclaim it.
 *
 * DERIVED from {@link APPROVAL_TIMEOUT_MAX_MS} rather than written as its own
 * duration, so the ordering is structural instead of a comment two files apart:
 * at twice the longest possible wait, the wait ALWAYS times out — freeing the
 * thread through the normal rejection path — with a full timeout's margin
 * before the reclaim can consider the thread abandoned. The reclaim still
 * exists for the case the timeout cannot cover: an instance that died without
 * ever running its wait to completion.
 */
const ABANDONED_APPROVAL_MS: number = 2 * APPROVAL_TIMEOUT_MAX_MS;

/** Stamp a registered function internal — server-side callable only. */
const asInternal = <T>(function_: T): T => {
    return { ...function_, visibility: "internal" };
};

/**
 * Drop the `undefined`-valued keys from an optional-column bag so a
 * `defineTable` insert never writes an explicit `undefined` (which the
 * validators reject) — the spread-and-omit pattern for `owner`/`title`/
 * `instanceId`/`state`, hoisted out of the insert to keep the handler's
 * cyclomatic complexity flat as more optional columns are added.
 */
const definedColumns = (columns: Record<string, unknown>): Record<string, unknown> => {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(columns)) {
        if (value !== undefined) {
            result[key] = value;
        }
    }

    return result;
};

/**
 * The shortest time a supplied secret value stays takeable. It covers the gap until
 * the model's next turn calls the consuming tool, and the consumer's `discard`
 * removes the value sooner on the success path; this bound is the backstop for a
 * crash in between. A supply that may need to outlast its wake-up is given its
 * deadline instead (see `secretValueTtlMs` in component.ts).
 */
const AGENT_SECRET_TTL_MS: number = 15 * 60 * 1000;

/**
 * Slack past a secret request's deadline before the loop's wait gives up. The
 * request row fixes `expiresAt` inside a durable step, and the wait is armed a
 * moment later, so a timeout measured from the wait alone could fire before the
 * deadline. The grace keeps the host timeout after `expiresAt`, so a supply
 * accepted at the last instant still finds the wait open.
 */
const SECRET_WAIT_GRACE_MS: number = 60 * 1000;

export type { AgentRegisteredFunction };
export { ABANDONED_APPROVAL_MS, AGENT_EXTENSION_KEY, AGENT_SECRET_TTL_MS, APPROVAL_TIMEOUT_MAX_MS, asInternal, definedColumns, SECRET_WAIT_GRACE_MS };
