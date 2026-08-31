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
 * `accessRoles` default group reader (`roles.ts`) agree on fallback order and
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

export { isAccessIdentity, readIdentityGroups };
