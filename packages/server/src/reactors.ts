/**
 * `onQueryChange` — server-side reactivity, the basis for actor patterns.
 *
 * Lunora's reactivity has always terminated at a socket: `refreshSubscriptions`
 * walks the connected WebSockets and pushes each one a fresh frame. That is the
 * right shape for a UI and the wrong shape for an actor — a matching engine, a
 * scheduler, an agent — which needs to WAKE when the state it watches moves,
 * with no client involved and nothing polling.
 *
 * A reactor is that subscriber. It declares a read and a handler, and the shard
 * runs the handler after a write flush **only when the read's result actually
 * changed**:
 *
 * ```ts
 * // lunora/reactors.ts
 * import { onQueryChange } from "@lunora/server";
 *
 * export const dispatchWaiting = onQueryChange(
 *     (ctx) => ctx.db.orders.findMany({ where: { status: "waiting" } }),
 *     async (ctx, waiting) => {
 *         for (const order of waiting) {
 *             await ctx.db.orders.patch(order._id, { status: "dispatched" });
 *         }
 *     },
 * );
 * ```
 *
 * # How this differs from `.triggers()`
 *
 * One sentence: **a trigger fires on a row write; a reactor fires on a query
 * result changing.** They are not two ways to do one thing.
 *
 * A trigger runs inside the write, once per row, and sees only that row. It
 * cannot answer "did the set of waiting orders become non-empty" without
 * re-deriving the set on every single write. A reactor runs after the flush,
 * once, against the whole result — and does not run at all when the write could
 * not have changed it. Writes to rows the read does not select, or to fields it
 * does not project, produce no reactor run. It is debounced by semantics rather
 * than by a timer.
 *
 * Reach for a trigger to maintain an invariant on a row (a denormalized counter,
 * a cascading write, a validation). Reach for a reactor when a decision depends
 * on the shape of a whole result set.
 *
 * # The convergence contract
 *
 * A reactor's handler writes, and its writes flush, and that flush re-evaluates
 * reactors. That loop is the feature — it is how an actor advances a state
 * machine one step at a time — and it is also how a badly written reactor spins
 * a shard forever.
 *
 * The baseline stored after a run is the digest of the result the handler was
 * given, BEFORE it ran. So a handler that changes its own read's result will be
 * invoked again on the new result, and again, until the result stops moving. A
 * converging reactor is one whose handler eventually makes no change its own
 * `select` can see — the example above converges because a dispatched order
 * leaves the `waiting` set.
 *
 * The framework bounds the other case rather than trusting it: a reactor that
 * runs more than a fixed number of times within a single refresh drain is
 * stopped for the remainder of that drain and the failure is logged. The shard
 * stays responsive; the reactor is simply wrong and now says so.
 *
 * # What the handler sees, and what it does not
 *
 * The handler receives the CURRENT result. It does not receive the previous one:
 * keeping every reactor's full prior result durable is an unbounded cost for a
 * value most handlers do not read. When a diff is genuinely needed, project what
 * matters into a `.memory()` table and compare against that — the two features
 * compose exactly for this, and the projection is rebuilt by `onShardInit` after
 * an eviction like any other ephemeral state.
 *
 * # Execution
 *
 * A reactor is an internal mutation that dispatches with no request identity, so
 * `ctx.auth` is anonymous. **It runs system-trusted: RLS does not apply, even
 * under `.rls("required")`.** That is not an exemption bolted on for
 * convenience — RLS scopes rows to a user, and a reactor has no user to scope to.
 * It fires because data moved. Running it under the last writer's identity would
 * be worse than running it as nobody, and failing it closed would make reactors
 * unusable on exactly the schemas that most want them.
 *
 * The consequence is the important part: **`select` sees every row in the
 * table.** Scope it yourself — by shard key, tenant column, or an explicit
 * predicate — exactly as you would in a migration or a cron job, which run in
 * this same tier.
 *
 * Its first ever run always fires, with whatever the read returns (often an
 * empty list), because "no baseline" is read as "changed" and never as
 * "unchanged" — the degradation direction that costs a redundant run rather than
 * a missed one. Write handlers to tolerate that.
 */

import { contentDigest } from "../../../shared/content-digest";
import { stableStringify } from "../../../shared/stable-key";
import type { MutationCtx as MutationContext, QueryCtx as QueryContext, RegisteredFunction } from "./types";

/**
 * The read a reactor watches. Runs on every flush that touched a table it read
 * last time, so keep it indexed and bounded — this is the reactor's steady-state
 * cost, paid whether or not the handler ends up running.
 */
type ReactorSelect<T> = (context: QueryContext) => Promise<T> | T;

/** What runs when {@link ReactorSelect}'s result changes. Receives the current result. */
type ReactorHandler<T> = (context: MutationContext, result: T) => Promise<void> | void;

/**
 * The framework-supplied argument to a reactor dispatch: the digest the shard
 * has on file for this reactor, or absent on its first run. Never authored by an
 * app — the DO supplies it from `__reactor_state`.
 */
interface ReactorDispatchArgs {
    previousDigest?: string;
}

/**
 * A registered reactor — an internal mutation tagged `lifecycle: "reactor"`.
 *
 * Typed separately from `RegisteredLifecycleHook` (which returns `void`) because
 * a reactor dispatch reports a {@link ReactorOutcome} back to the shard: the
 * digest becomes the next baseline, and the shard cannot compute it itself
 * without re-running the read.
 */
type RegisteredReactor = RegisteredFunction<Record<string, never>, ReactorOutcome, "mutation"> & { readonly lifecycle: "reactor" };

/** What a reactor dispatch reports back so the shard can update the baseline. */
interface ReactorOutcome {
    /** Digest of the result the handler was given (or would have been). */
    digest: string;
    /** Whether the handler actually ran — `false` when the result was unchanged. */
    ran: boolean;
}

/**
 * Register a reactor: run `handler` after a write flush, whenever `select`'s
 * result differs from the last result the handler saw. See the module docblock
 * for the trigger comparison and the convergence contract.
 *
 * The read is an inline callback rather than a reference to a registered query
 * on purpose. It keeps the declaration statically discoverable with no import
 * resolution and no dependency on `_generated/api`, and it lets the read and the
 * handler share one transaction and one read footprint.
 *
 * That shared footprint is deliberately conservative: it is the union of what
 * `select` AND `handler` read, so a table the handler merely consults can wake
 * the reactor later. The cost of that is one extra `select` — whose digest then
 * matches and suppresses the handler — never a missed reaction.
 */
const onQueryChange = <T>(select: ReactorSelect<T>, handler: ReactorHandler<T>): RegisteredReactor => {
    return {
        args: {},
        handler: async (context: unknown, args: unknown): Promise<ReactorOutcome> => {
            const result = await select(context as QueryContext);
            // `stableStringify` (not `JSON.stringify`) because key order must not
            // decide whether a reactor fires: two structurally identical results
            // have to digest identically, or every flush would look like a change.
            const digest = contentDigest(stableStringify(result));

            if (digest === (args as ReactorDispatchArgs | undefined)?.previousDigest) {
                return { digest, ran: false };
            }

            await handler(context as MutationContext, result);

            return { digest, ran: true };
        },
        kind: "mutation",
        lifecycle: "reactor",
        visibility: "internal",
    };
};

export { onQueryChange };
export type { ReactorDispatchArgs, ReactorHandler, ReactorOutcome, ReactorSelect, RegisteredReactor };
