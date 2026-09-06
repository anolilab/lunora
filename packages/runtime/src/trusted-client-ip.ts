import { onCloudflareEdge } from "../../../shared/on-cloudflare-edge";

/**
 * The caller's IP for a request, or `undefined` when nothing trustworthy says.
 *
 * `cf-connecting-ip` is the only client-address header believed without being
 * asked for, and only where {@link onCloudflareEdge} holds — there the edge
 * stamps it over whatever the client sent. Off the edge nothing overwrites it,
 * so by default this resolves NOTHING rather than falling back to
 * `x-forwarded-for` or the raw header: both are client-written there, and an
 * attacker-chosen address is worse than a missing one — it silently defeats
 * every rate limit keyed on it while reading as if the limit were enforced.
 * Callers already handle the absent case (the REST limiter falls into its shared
 * `no-trusted-ip` bucket; `ctx.ip` is documented optional).
 *
 * `trustedClientIpHeader` is the operator's opt-out of that default, for the one
 * deployment where the default is wrong rather than merely conservative: an
 * origin sitting BEHIND a proxy that does stamp a client address. See the
 * `WorkerOptions.trustedClientIpHeader` docblock for what declaring it asserts.
 * It is the runtime's spelling of `@lunora/auth`'s `trustedProxies` opt-in — the
 * same "off the edge, believe a header only once an operator has declared it"
 * shape — but a header NAME rather than a list of proxy addresses, because the
 * runtime never sees a peer address to match such a list against: `fetch` hands
 * it a `Request` and nothing else, on workerd and on `@lunora/platform-node`
 * alike. Declaring the header is the only assertion this layer can actually act
 * on. Names are compared case-insensitively, as `Headers.get` already is.
 *
 * On the edge the declaration is ignored and `cf-connecting-ip` still wins:
 * there the runtime knows the trustworthy answer without being told, and letting
 * a config value override it could only make it worse.
 *
 * A value containing a comma is refused. That is the shape of an appended
 * forwarding chain (`x-forwarded-for: <client>, <hop>`), whose leftmost entry is
 * whatever the client typed — reading one as a single address would hand back
 * exactly the attacker-chosen string this module exists to refuse, and the
 * runtime has no chain walker to do better (`@lunora/auth` does, which is why
 * its opt-in takes proxy addresses and can accept a chain). So the declaration
 * only means anything for a header the fronting infrastructure REPLACES.
 *
 * The rest of the policy stays `@lunora/runtime`'s own rather than shared:
 * `@lunora/auth` answers the same question differently, and neither package
 * should inherit the other's choice by importing a helper that made it. Only the
 * "am I on Cloudflare?" predicate underneath is shared, so the two cannot
 * disagree about the runtime while disagreeing about the policy.
 */
// eslint-disable-next-line import/prefer-default-export -- named export: import sites stay uniform (`import { trustedClientIp }`), per the repo's no-default-mixing convention
export const trustedClientIp = (headers: Headers, trustedClientIpHeader: string | undefined): string | undefined => {
    if (onCloudflareEdge()) {
        return headers.get("cf-connecting-ip") ?? undefined;
    }

    if (trustedClientIpHeader === undefined) {
        return undefined;
    }

    const value = headers.get(trustedClientIpHeader)?.trim();

    return value === undefined || value === "" || value.includes(",") ? undefined : value;
};
