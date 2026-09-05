import type { AccessContextLike, AccessIdentityLike, ExecutionContextLike } from "../../../shared/execution-context";
import type { AccessClaims } from "./types";

/**
 * Read one group entry's name. Access emits group membership either as plain
 * names or as `{ id, name }` objects depending on the identity provider and the
 * policy; both normalize to the name, which is what an Access policy is written
 * against and what `createAccessResolver({ roles })` maps into the `roles`
 * claim. Anything else
 * (a number, a nameless object) contributes nothing rather than stringifying
 * into a role nobody configured.
 */
const groupName = (entry: unknown): string | undefined => {
    if (typeof entry === "string") {
        return entry.length > 0 ? entry : undefined;
    }

    if (typeof entry === "object" && entry !== null) {
        const { name } = entry as { name?: unknown };

        return typeof name === "string" && name.length > 0 ? name : undefined;
    }

    return undefined;
};

/**
 * Normalize whatever the platform put in `groups` to the `string[]` the JWT path
 * produces, so a policy or the resolver's role mapping reads the same regardless of
 * which path authenticated the caller. A non-array (absent, or a shape we don't
 * recognize) yields `undefined` — the claim is then simply absent, never `[]`,
 * which would falsely assert "verified: this user is in no groups".
 */
const normalizeGroups = (groups: unknown): string[] | undefined =>
    Array.isArray(groups) ? groups.map((entry) => groupName(entry)).filter((name): name is string => name !== undefined) : undefined;

/**
 * Read the identity Cloudflare Access attached to a Worker-protected request and
 * project it onto {@link AccessClaims} — the same claim shape the
 * `Cf-Access-Jwt-Assertion` path produces, so everything downstream (identity
 * mapping, `ctx.access`, the mapped RLS roles, RLS policies) is indifferent to which
 * path authenticated the caller.
 *
 * Returns `undefined` when Access did not authenticate this request (`ctx.access`
 * is absent), when the host supplied no `ExecutionContext` at all, or when
 * `getIdentity()` yields nothing usable — the same fail-closed "no Access
 * identity" signal `verifyRequest` returns, so callers treat the two uniformly.
 *
 * Nothing is verified here, and nothing needs to be: the platform authenticated
 * the caller before the Worker ran and the identity arrives out-of-band, not on
 * the request. There is no token to check a signature or audience against, and
 * no header a caller could forge to manufacture one — `context.access` simply
 * does not exist unless Access authorized the call.
 */
const readPlatformIdentity = async (context: ExecutionContextLike | undefined): Promise<AccessClaims | undefined> => {
    const access: AccessContextLike | undefined = context?.access;

    if (access === undefined) {
        return undefined;
    }

    let identity: AccessIdentityLike | null | undefined;

    try {
        identity = await access.getIdentity();
    } catch {
        // Fail closed to anonymous, matching the JWT path: a platform read that
        // throws must not 500 the request, and must not be mistaken for an
        // authenticated caller.
        return undefined;
    }

    if (identity === null || typeof identity !== "object") {
        return undefined;
    }

    // `groups` is the one field whose wire shape differs between the two paths,
    // so it is lifted out and re-added normalized; every other field passes
    // through verbatim (Cloudflare may add more, and dropping them would make
    // `ctx.access.claims` a lossy view of an identity we do not own).
    const { groups, ...rest } = identity;
    const names = normalizeGroups(groups);

    return names === undefined ? rest : { ...rest, groups: names };
};

export default readPlatformIdentity;
