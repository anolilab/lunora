/**
 * The headers a trusted server-initiated dispatch carries into a shard's `/rpc`.
 *
 * Shared by `@lunora/runtime`'s `dispatchToShard` (cron, scheduler, and the
 * `ctx.run*` path) and `@lunora/platform-node`'s dispatch route, so both hosts put
 * the same trust-boundary headers on the same call. Build the set in one place.
 *
 * `x-lunora-system` is a trust-boundary header: it lets the shard run `internal`
 * functions. Only the admin/HMAC-gated dispatch paths may call this. Never call it
 * from the client RPC path.
 *
 * Like `shared/constant-time-equal.ts`, not a package: keep it zero-dependency
 * (relative imports only).
 */

import { ORIGIN_PAYWALL_APPLIED, ORIGIN_PAYWALL_HEADER } from "./origin-paywall";

interface SystemDispatchOptions {
    /** A verified caller identity the trusted caller forwarded, if any. */
    forwardedIdentity?: { identity?: string; userId?: string };
    /** A stable per-job id, used by the shard as the idempotency key. */
    mutationId?: string;
    /** The caller's W3C traceparent, so the shard joins the caller's trace. */
    traceparent?: string;
}

/**
 * The paywall marker rides along because a scheduler or cron fire has no HTTP
 * caller to charge, so running a `.x402`-tagged target unpaid is deliberate here.
 * A forwarded `x-lunora-userid` / `x-lunora-identity` coexists with
 * `x-lunora-system`: the call runs with system privileges and the caller's RLS
 * context. `x-lunora-mutation-id` makes an at-least-once re-fire collapse on the
 * shard's idempotency table rather than apply its effect twice.
 */
const buildSystemDispatchHeaders = ({ forwardedIdentity, mutationId, traceparent }: SystemDispatchOptions): Record<string, string> => {
    const headers: Record<string, string> = {
        "content-type": "application/json",
        [ORIGIN_PAYWALL_HEADER]: ORIGIN_PAYWALL_APPLIED,
        "x-lunora-system": "1",
    };

    if (forwardedIdentity?.userId !== undefined && forwardedIdentity.userId.length > 0) {
        headers["x-lunora-userid"] = forwardedIdentity.userId;
    }

    if (forwardedIdentity?.identity !== undefined && forwardedIdentity.identity.length > 0) {
        headers["x-lunora-identity"] = forwardedIdentity.identity;
    }

    if (mutationId !== undefined && mutationId.length > 0) {
        headers["x-lunora-mutation-id"] = mutationId;
    }

    if (traceparent !== undefined && traceparent.length > 0) {
        headers.traceparent = traceparent;
    }

    return headers;
};

/**
 * Read the optional caller identity a server-initiated dispatch forwards on the
 * `x-lunora-userid` / `x-lunora-identity` headers. Both values are kept as the raw
 * strings the scheduler or dispatch sender wrote, unchanged: the shard decodes
 * them, not the host. Returns `undefined` when neither header is present.
 */
const readForwardedDispatchIdentity = (request: Request): { identity?: string; userId?: string } | undefined => {
    const forwardedUserId = request.headers.get("x-lunora-userid");
    const forwardedIdentity = request.headers.get("x-lunora-identity");

    if (forwardedUserId === null && forwardedIdentity === null) {
        return undefined;
    }

    return {
        ...(forwardedIdentity === null ? {} : { identity: forwardedIdentity }),
        ...(forwardedUserId === null ? {} : { userId: forwardedUserId }),
    };
};

export type { SystemDispatchOptions };
export { buildSystemDispatchHeaders, readForwardedDispatchIdentity };
