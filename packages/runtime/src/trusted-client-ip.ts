import { onCloudflareEdge } from "../../../shared/on-cloudflare-edge";

/**
 * The caller's IP for a request, or `undefined` when nothing trustworthy says.
 *
 * `cf-connecting-ip` is the only client-address header worth reading, and only
 * where {@link onCloudflareEdge} holds. Off the edge this deliberately resolves
 * NOTHING rather than falling back to `x-forwarded-for` or the raw header: both
 * are client-written there, and an attacker-chosen address is worse than a
 * missing one — it silently defeats every rate limit keyed on it while reading
 * as if the limit were enforced. Callers already handle the absent case (the
 * REST limiter falls into its shared `no-trusted-ip` bucket; `ctx.ip` is
 * documented optional).
 *
 * This is `@lunora/runtime` policy, not a repo-wide one, and lives here for that
 * reason: it picks the header and it picks "resolve nothing" over a fallback.
 * `@lunora/auth` answers the same question differently — it accepts declared
 * `trustedProxies` and will then read an `x-forwarded-for` chain — and neither
 * package should inherit the other's choice by importing a shared helper that
 * made it. Only the "am I on Cloudflare?" predicate underneath is shared, so the
 * two cannot disagree about the runtime while disagreeing about the policy.
 *
 * ## Deployments this makes worse, on purpose
 *
 * A `@lunora/platform-node` origin sitting BEHIND Cloudflare is the honest cost.
 * There the edge really does stamp `cf-connecting-ip`, and if the origin accepts
 * only Cloudflare traffic the header really is trustworthy — but this code runs
 * on the origin, where `navigator.userAgent` says Node, and nothing in a request
 * distinguishes that deployment from one exposed directly. So it resolves
 * nothing, and every caller pools into `no-trusted-ip`: one shared bucket any
 * single client can exhaust. That is a DIFFERENT failure mode, not a smaller
 * one — it trades "an attacker escapes their own limit" for "an attacker locks
 * out every honest caller".
 *
 * Those deployments should pass an explicit `key` to `createRestRateLimit` (see
 * `packages/runtime/docs/index.mdx`), which is the one place that knows the
 * origin is fronted. There is no trusted-proxy switch here: the runtime has
 * nowhere to declare one, and a config knob that turns this gate back off is a
 * design decision, not a default.
 */
// eslint-disable-next-line import/prefer-default-export -- named export: import sites stay uniform (`import { trustedClientIp }`), per the repo's no-default-mixing convention
export const trustedClientIp = (headers: Headers): string | undefined => (onCloudflareEdge() ? (headers.get("cf-connecting-ip") ?? undefined) : undefined);
