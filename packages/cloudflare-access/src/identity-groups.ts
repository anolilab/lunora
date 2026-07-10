/**
 * Read the IdP group memberships off a resolved Access identity envelope: the
 * promoted top-level `groups`, falling back to the verified nested `access.groups`,
 * keeping only the string entries. Returns `undefined` when neither yields a group
 * array.
 *
 * The single source of truth shared by the `ctx.access` facade (`context.ts`) and
 * the `accessRoles` default group reader (`roles.ts`), so the two can never drift
 * on fallback order or filtering — a divergence would silently desync the RLS
 * roles a request carries from what `ctx.access.groups` / `hasGroup` report for the
 * same request. Both subpath bundles inline this file, so the package export shape
 * is unchanged.
 */
const readIdentityGroups = (identity: Record<string, unknown>): ReadonlyArray<string> | undefined => {
    const access = identity["access"];
    const nested = typeof access === "object" && access !== null ? (access as { groups?: unknown }).groups : undefined;
    const groups = identity["groups"] ?? nested;

    return Array.isArray(groups) ? groups.filter((group): group is string => typeof group === "string") : undefined;
};

export { readIdentityGroups };
