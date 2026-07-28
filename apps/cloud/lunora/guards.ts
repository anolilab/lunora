import type { RateLimitConfigMap, RateLimitDb } from "@lunora/ratelimit";
import { dbRateLimit as databaseRateLimitMiddleware } from "@lunora/ratelimit";
import type { Middleware } from "@lunora/server";

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
 * .use(rateLimit("api"))
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
 * **Keying.** Buckets key on the signed-in user, falling back to the caller IP for
 * machine traffic (deploy-key authorized ingest, provider webhooks), which carries
 * no session. Per-*tenant* fairness is the router's job, not this tier's: procedure
 * middleware receives only `ctx`, so the validated `organizationId`/`deployKey` args
 * are out of reach here and machine buckets are necessarily IP-keyed. See
 * {@link callerKey}.
 */

/** Requests per minute, expressed as a token bucket that also caps the burst. */
const perMinute = (rate: number) => ({ capacity: rate, kind: "token bucket", period: 60_000, rate }) as const;

/** Requests per hour, for buckets that meter a genuinely expensive resource. */
const perHour = (rate: number) => ({ capacity: rate, kind: "token bucket", period: 3_600_000, rate }) as const;

/**
 * Every bucket the control plane meters, loosest to tightest. The keys are the
 * bucket argument to {@link dbRateLimit}; an unconfigured name
 * throws an `INTERNAL` error rather than silently admitting traffic.
 */
export const RATE_LIMITS = {
    /**
     * Machine telemetry ingest (logs, metrics, spans, usage) — deploy-key
     * authorized and high-volume by nature.
     *
     * Mirrors the router's per-IP `telemetryIp` backstop (12 000/min), NOT its
     * per-token `telemetry` bucket (6 000/min). The two are keyed differently and
     * conflating them is a live throttle: {@link callerKey} has only `ctx`, never
     * the validated `deployKey`/`organizationId` args, so machine traffic keys on
     * the caller IP. An IP-keyed 6 000 sits *below* the outer IP backstop, so the
     * inner tier fired first on every router-fronted exporter — inverting the
     * design and giving none of the per-tenant fairness the outer per-token bucket
     * exists to provide. At parity the outer tier stays the one that throttles
     * router traffic, while a caller reaching the RPC surface directly (bypassing
     * `/v1/*`, which has no outer limit at all) is still bounded.
     */
    ingest: perMinute(12_000),

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

/** The bucket names {@link rateLimit} accepts. */
export type RateLimitBucket = keyof typeof RATE_LIMITS;

/**
 * Sub-key for a limit: the signed-in user when there is a session, else the
 * caller IP. Machine callers (deploy-key ingest, provider webhooks) have no
 * session and fall through to the IP. `undefined` — an unauthenticated call with no
 * forwarded IP, e.g. a server-initiated dispatch — shares one process-wide bucket
 * rather than escaping the limit entirely. Nothing rate-limited reaches that path
 * today (crons call `internal*` procedures, which carry no limiter), but a future
 * `ctx.runMutation` from a cron into a public mutation would land every caller in
 * one counter; key such a path explicitly if that ever happens.
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

/**
 * The rate-limit middleware for one bucket — the only thing a procedure needs:
 * `.use(rateLimit("api"))`.
 *
 * Binds the config and the key selector so neither can be forgotten. The previous
 * shape — `dbRateLimit(RATE_LIMITS, "api", { key: callerKey })` spelled out at 49
 * sites — made the key look optional: omit it at one procedure and that bucket
 * silently becomes a single global counter shared by every caller, with no type
 * error and no test that would notice.
 *
 * **The name is deliberate, not lazy.** `@lunora/codegen`'s feeder decides whether a
 * procedure is rate-limited by matching the callee name of each `.use(f(...))`
 * against `{ rateLimit, dbRateLimit, … }` — by name, explicitly, so degraded type
 * info cannot blind the lint. A wrapper called anything outside that set (`limit`)
 * makes all 49 procedures read as unprotected and re-fires
 * `public_mutation_without_ratelimit`, so the ergonomic win would have cost a
 * security lint. `rateLimit` is in the set and, unlike `dbRateLimit`, carries no
 * abbreviation for `unicorn/prevent-abbreviations` to object to.
 *
 * Generic in the context for the same reason as {@link callerKey}: `Context`
 * appears only in the return type, so it is inferred from the `.use()` site and the
 * procedure's real ctx flows through. Naming it concretely pins the chain to the
 * constraint and strips `now`/`payments`/`ai` off every downstream handler. The
 * constraint spans both halves the middleware touches — `db` for the store,
 * `auth`/`ip` for {@link callerKey} — so the two stay unifiable.
 */
export const rateLimit = <Context extends { auth: { userId: string | null }; db: RateLimitDb; ip?: string }>(
    bucket: RateLimitBucket,
): Middleware<Context, Context> => databaseRateLimitMiddleware<Context>(RATE_LIMITS, bucket, { key: callerKey });
