/**
 * True when `identity` is an **Access** identity envelope — i.e. it carries the
 * verified claim set under `access`, the shape `createAccessResolver` produces.
 *
 * Under `composeResolvers` a request's identity may come from a foreign adapter
 * (better-auth, a custom SSO mapping), and the runtime forwards that whole
 * envelope to `getIdentity()`. Any top-level field on it — `groups` included —
 * is then user-influenced data that Access never verified, so every consumer
 * that treats the envelope as Access-authenticated must gate on this first.
 */
const isAccessIdentity = (identity: Record<string, unknown>): boolean => {
    const { access } = identity;

    return typeof access === "object" && access !== null;
};

/**
 * Read the IdP group memberships off a resolved Access identity envelope: the
 * promoted top-level `groups`, falling back to the verified nested `access.groups`,
 * keeping only the string entries. Returns `undefined` when neither yields a group
 * array.
 *
 * It guarantees ONE thing: that the `ctx.access` facade (`context.ts`) and the
 * resolver-minted RLS roles (`resolver.ts`) agree on fallback order and
 * filtering, so RLS roles never desync from what `ctx.access.groups` / `hasGroup`
 * report for the same request.
 *
 * It guarantees NOTHING about provenance. The promoted `groups` it prefers is a
 * plain top-level field that any resolver can set, so this reader will happily
 * return a foreign envelope's `groups`. Callers must establish that the envelope
 * is an Access identity with {@link isAccessIdentity} BEFORE trusting the result;
 * both in-repo callers do. Both subpath bundles inline this file, so the package
 * export shape is unchanged.
 */
const readIdentityGroups = (identity: Record<string, unknown>): ReadonlyArray<string> | undefined => {
    const { access } = identity;
    const nested = typeof access === "object" && access !== null ? (access as { groups?: unknown }).groups : undefined;
    const groups = identity["groups"] ?? nested;

    return Array.isArray(groups) ? groups.filter((group): group is string => typeof group === "string") : undefined;
};

/** A group→role(s) lookup table, or a function returning the role(s) for one group. */
type AccessRoleMap = ((group: string) => string | string[] | undefined) | Record<string, string | string[]>;

/** Resolve one group to its zero-or-more role names through `map`. */
const rolesForGroup = (group: string, map: AccessRoleMap): ReadonlyArray<string> => {
    const resolved = typeof map === "function" ? map(group) : map[group];

    if (resolved === undefined) {
        return [];
    }

    return Array.isArray(resolved) ? resolved : [resolved];
};

/**
 * Map verified IdP groups onto RLS role names, deduplicated in first-seen order.
 * Returns `undefined` when there is nothing to mint — no map, no groups, or a
 * map that dropped every one of them — so a caller can leave the `roles` claim
 * off an identity entirely rather than stamping an empty array.
 *
 * No map means NO roles, deliberately: promoting every group name to a role by
 * default would grant role-gated permissions to deployments that never asked
 * for them. `(group) => group` opts into the verbatim mapping.
 */
const rolesForGroups = (groups: ReadonlyArray<string> | undefined, map: AccessRoleMap | undefined): string[] | undefined => {
    if (map === undefined || groups === undefined || groups.length === 0) {
        return undefined;
    }

    const roles = new Set<string>();

    for (const group of groups) {
        for (const role of rolesForGroup(group, map)) {
            roles.add(role);
        }
    }

    return roles.size === 0 ? undefined : [...roles];
};

export type { AccessRoleMap };
export { isAccessIdentity, readIdentityGroups, rolesForGroups };
