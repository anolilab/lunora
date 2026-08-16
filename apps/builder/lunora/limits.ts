import { createDbStore, RateLimiter } from "lunorash/ratelimit";

import type { ActionCtx, MutationCtx } from "#lunora/_generated/server.js";

/**
 * Abuse protection for the public write paths — **not** the product's quota.
 *
 * Plan 335 §D17 meters turns and tokens through `tokenBudget`, which is W7 and
 * is about what a user is entitled to spend. This is the cruder thing underneath
 * it: a cap that stops an unauthenticated caller minting projects, opening
 * chats or running commands in a loop. The two exist for different reasons and
 * should not be collapsed — a generous quota is still a quota, and this floor
 * has to hold even for a user who has plenty of budget left.
 *
 * Three buckets rather than one, sized by what the operation costs us:
 * `write` is a database row, `chat` starts an agent turn, `exec` runs a process.
 */
const LIMITS = {
    chat: { kind: "token bucket", period: 60_000, rate: 30 },
    exec: { kind: "token bucket", period: 60_000, rate: 15 },
    write: { kind: "token bucket", period: 60_000, rate: 120 },
} as const;

/**
 * One limiter per context kind, rather than one generic limiter.
 *
 * A middleware's context type flows into the handler it guards, so a single
 * limiter typed `MutationCtx` silently narrowed the `action` it was attached to
 * — `ctx.runQuery` and `ctx.containers` vanished from a handler that needs them.
 * Widening it to a structural `{ db: unknown }` was worse: the handler then lost
 * `ctx.db` and `ctx.log` too. A generic factory keeps each procedure's context
 * exactly what its kind promises, with one implementation behind both.
 */
const makeLimiter = (ctx: { db: unknown }): RateLimiter<keyof typeof LIMITS> =>
    new RateLimiter({ config: LIMITS, store: createDbStore({ db: ctx.db as never, table: "ratelimit_buckets" }) });

/**
 * The two exported limiters are the SAME function, annotated with the context
 * each is attached to. The annotation is the whole point: a middleware's
 * context type flows into the handler it guards, so exporting the structural
 * `makeLimiter` directly would erase `ctx.log`, `ctx.db` or `ctx.runQuery` from
 * whichever handler used it.
 */
const limiter: (ctx: MutationCtx) => RateLimiter<keyof typeof LIMITS> = makeLimiter;

/** For `action` procedures, whose ctx is a different type carrying the same `db`. */
const actionLimiter: (ctx: ActionCtx) => RateLimiter<keyof typeof LIMITS> = makeLimiter;

/**
 * Anonymous callers share a bucket per session; signed-in ones get their own.
 *
 * `"anon"` is a single shared bucket on purpose at this stage: without accounts
 * there is no identity to key on, and an IP-derived key would be both spoofable
 * and wrong behind a shared NAT. It is deliberately conservative until W7 gives
 * anonymous sessions a real identity.
 */
const limitKey = (ctx: { auth: { userId?: string | null } }): string => ctx.auth.userId ?? "anon";

/**
 * Call sites write `.use(rateLimit(limiter, "chat", { key: limitKey }))` in full
 * rather than through a `limit("chat")` wrapper.
 *
 * The wrapper existed first and was reverted: `@lunora/advisor`'s
 * `public_mutation_without_ratelimit` lint pattern-matches a literal
 * `rateLimit(...)` inside `.use(...)`, so routing it through a helper made every
 * guarded mutation read as unguarded. A little repetition is worth keeping the
 * gate able to see the thing it exists to check — an abstraction that blinds a
 * lint is worse than the duplication it removes.
 */
export { actionLimiter, limiter, limitKey, LIMITS };
