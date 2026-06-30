import type { Middleware } from "@lunora/server";

/**
 * The slice of context {@link accessRoles} reads and augments: the `auth` facade
 * every Lunora ctx carries. `getIdentity()` returns the verified identity
 * envelope (`createAccessResolver`'s output, including `groups`); `roles` is the
 * per-request role list `rls()` unions permissions over.
 */
interface AccessRolesContext {
    auth?: {
        getIdentity?: () => (Record<string, unknown> | null) | Promise<Record<string, unknown> | null>;
        roles?: ReadonlyArray<string>;
        userId?: string | null;
    };
}

/** A group→role(s) lookup table, or a function returning the role(s) for one group. */
type AccessRoleMap = ((group: string) => string | string[] | undefined) | Record<string, string | string[]>;

/** Options for {@link accessRoles}. */
interface AccessRolesOptions {
    /**
     * Map verified Access group names to RLS role names. A table
     * (`{ "idp-admins": "admin", "idp-eng": ["editor", "viewer"] }`) or a
     * function; either may return one role, an array, or `undefined` to drop the
     * group. Omit to use each group name verbatim as a role.
     */
    map?: AccessRoleMap;

    /**
     * Read the group list off the resolved identity. Defaults to the `groups`
     * claim (`string[]`). Override when your IdP nests groups elsewhere.
     */
    readGroups?: (identity: Record<string, unknown>) => ReadonlyArray<string> | undefined;
}

/**
 * Default group reader: the promoted top-level `groups` claim, falling back to
 * the verified nested `access.groups`. This mirrors the `ctx.access` facade in
 * `context.ts` (`identity.groups ?? identity.access.groups`), so a custom
 * `mapClaims` that stops promoting `groups` still feeds `accessRoles` instead of
 * silently stripping every RLS role. Keeps only the string entries.
 */
const defaultReadGroups = (identity: Record<string, unknown>): ReadonlyArray<string> | undefined => {
    const { access } = identity;
    const nested = typeof access === "object" && access !== null ? (access as { groups?: unknown }).groups : undefined;
    const groups = identity["groups"] ?? nested;

    return Array.isArray(groups) ? groups.filter((group): group is string => typeof group === "string") : undefined;
};

/** Resolve one group to its zero-or-more role names through `map` (verbatim when unset). */
const rolesForGroup = (group: string, map: AccessRoleMap | undefined): ReadonlyArray<string> => {
    if (map === undefined) {
        return [group];
    }

    const resolved = typeof map === "function" ? map(group) : map[group];

    if (resolved === undefined) {
        return [];
    }

    return Array.isArray(resolved) ? resolved : [resolved];
};

/**
 * Middleware that lifts the verified Cloudflare Access `groups` claim into
 * `ctx.auth.roles` so `rls()` policies can authorize by role. Place it **before**
 * `rls(...)` in the `.use(...)` chain — `rls()` reads `ctx.auth.roles` to union
 * the permissions a request carries.
 *
 * It reads the resolved identity via `ctx.auth.getIdentity()` (the output of
 * `createAccessResolver`), maps each group to role name(s), and unions them with
 * any roles already on `ctx.auth.roles` (so a role set by an earlier middleware
 * is preserved). When there is no identity or no groups it forwards the context
 * unchanged — anonymous requests stay role-less (fail-closed under RLS).
 *
 * ```ts
 * export const listInvoices = query
 *   .use(accessRoles({ map: { "idp-admins": "admin", "idp-billing": ["billing", "viewer"] } }))
 *   .use(rls(policies, { roles }))
 *   .query(async ({ ctx }) => ...);
 * ```
 */
const accessRoles = <Context extends AccessRolesContext>(options: AccessRolesOptions = {}): Middleware<Context, Context> => {
    const readGroups = options.readGroups ?? defaultReadGroups;

    return async ({ ctx, next }) => {
        const identity = (await ctx.auth?.getIdentity?.()) ?? undefined;
        const groups = identity ? readGroups(identity) : undefined;

        if (groups === undefined || groups.length === 0) {
            return next();
        }

        // Seed with any roles a prior middleware already set, then union the
        // group-derived ones; a Set dedups while preserving first-seen order.
        const roles = new Set<string>(ctx.auth?.roles);

        for (const group of groups) {
            for (const role of rolesForGroup(group, options.map)) {
                roles.add(role);
            }
        }

        return next({ ctx: { auth: { ...ctx.auth, roles: [...roles] } } });
    };
};

export { accessRoles };
export type { AccessRoleMap, AccessRolesContext, AccessRolesOptions };
