import type { RateLimitConfigMap } from "@lunora/ratelimit";

/**
 * The control plane's shared RPC rate limits — the second of two tiers.
 *
 * `src/deploy/router.ts` throttles the **HTTP** surface (`/v1/*`) per-IP and
 * per-ingest-token before a request ever reaches a function. This tier sits on
 * the **RPC** surface, so a public `mutation`/`action` called straight over the
 * client protocol (bypassing the router entirely) is bounded too. Every public
 * write attaches one of the buckets below:
 *
 * ```ts
 * .use(dbRateLimit(RATE_LIMITS, "api", { key: callerKey }))
 * ```
 *
 * **Store.** `dbRateLimit` keeps the token buckets in the `rateLimits` table via
 * `ctx.db`, not in memory. The router's limiter can be per-isolate because it
 * only fronts HTTP, but this tier also guards `action`s, and actions run in the
 * **Worker**, where each request may land on a fresh isolate — an in-memory
 * counter there never sums across them and the limit degrades to a no-op under
 * load. `rateLimits` is deliberately the one non-`.global()` table in the schema,
 * so it lives in the control-plane DO's SQLite: the store's read-then-write runs
 * under the DO input gate (atomic against concurrent callers) and the ingest
 * path doesn't pay a D1 write per telemetry batch.
 *
 * **Keying.** Buckets key on the signed-in user, falling back to the caller IP
 * for machine traffic (deploy-key authorized ingest, provider webhooks), which
 * carries no session. See {@link callerKey}.
 */

/** Requests per minute, expressed as a token bucket that also caps the burst. */
const perMinute = (rate: number) => ({ capacity: rate, kind: "token bucket", period: 60_000, rate }) as const;

/** Requests per hour, for buckets that meter a genuinely expensive resource. */
const perHour = (rate: number) => ({ capacity: rate, kind: "token bucket", period: 3_600_000, rate }) as const;

/**
 * Every bucket the control plane meters, loosest to tightest. The keys are the
 * `name` argument to `dbRateLimit(RATE_LIMITS, "&lt;bucket>")`; an unconfigured name
 * throws an `INTERNAL` error rather than silently admitting traffic.
 */
export const RATE_LIMITS = {
    /**
     * Machine telemetry ingest (logs, metrics, spans, usage). Deploy-key
     * authorized and high-volume by nature — matched to the router's `telemetry`
     * bucket so the two tiers agree rather than the inner one throttling first.
     */
    ingest: perMinute(6000),

    /** Deploy-key authorized control writes — build/deploy status callbacks from CI. */
    machine: perMinute(600),

    /** Provider-driven webhooks (billing). Signature-verified, so bound the flood, not the caller. */
    webhook: perMinute(600),

    /** Ordinary authenticated dashboard writes. Mirrors the router's `api` bucket. */
    api: perMinute(120),

    /** Archive reads that leave the DO for R2/Analytics — bounded because each one is a paid round-trip. */
    archive: perMinute(60),

    /** Checkout/portal session creation — each one hits the payment provider. */
    billing: perMinute(20),

    /** Resource-creating writes that provision real infrastructure (orgs, projects, deployments, domains). */
    provision: perMinute(20),

    /**
     * Credential- and claim-shaped writes: issuing/revoking/verifying a deploy
     * key, accepting an invitation, claiming a GitHub installation, requesting
     * org deletion. These are the brute-force and takeover targets.
     */
    sensitive: perMinute(20),

    /**
     * Durable AI incident analysis. Inference is billed to the **operator's**
     * account, not the tenant's, so this is metered per hour rather than per
     * minute — the tightest bucket in the app.
     */
    ai: perHour(10),
} satisfies RateLimitConfigMap;

/** The bucket names `dbRateLimit(RATE_LIMITS, …)` accepts. */
export type RateLimitBucket = keyof typeof RATE_LIMITS;

/**
 * Sub-key for a limit: the signed-in user when there is a session, else the
 * caller IP. Machine callers (deploy-key ingest, provider webhooks) have no
 * session and fall through to the IP. `undefined` — an unauthenticated call from
 * an unknown IP, e.g. a live-subscription re-run — shares one global bucket
 * rather than escaping the limit entirely.
 *
 * Generic in the context on purpose. `.use()` rewrites the chain's context to the
 * middleware's `Context`, which is inferred from this selector; pinning the
 * parameter to a concrete shape would narrow every downstream handler's `ctx` to
 * it and strip `db`/`now`/`payments`/`ai`. Staying generic lets the procedure's
 * real context flow through untouched.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- load-bearing: `rateLimit<Context>` infers Context from this selector, and `.use()` rewrites the chain's context to it. Inlining the constraint as the parameter type would pin every downstream handler's ctx to that shape.
export const callerKey = <Context extends { auth: { userId: string | null }; ip?: string }>(context: Context): string =>
    context.auth.userId ?? context.ip ?? "anonymous";
