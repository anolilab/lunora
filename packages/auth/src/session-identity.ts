import type { LunoraAuth } from "./create-auth";

/**
 * The claims both built-in wirings (D1 and the auth Durable Object) put on the
 * Lunora identity, derived from one better-auth `getSession` result. Each optional
 * claim is absent — never `undefined`, `null` or `""` — when the session does not
 * carry it, so the identity header stays minimal and an absent claim reads as absent.
 */
// A type alias, not an interface: only an alias gets the implicit index signature that
// lets it stand where the runtime's `ResolvedIdentity` (`[key: string]: unknown`) is expected.
type SessionIdentity = {
    /** Profile claim `ctx.auth.getIdentity()` is documented to carry. */
    email?: string;

    /**
     * The session's expiry (epoch ms). The runtime forwards it as the socket's
     * credential expiry (`x-lunora-identity-exp`); without it a signed-out, banned or
     * lapsed user keeps streaming RLS-scoped rows over an already-open WebSocket.
     */
    expiresAtMs?: number;

    /** Profile claim `ctx.auth.getIdentity()` is documented to carry. */
    name?: string;

    /**
     * The session's active organization (`organization()` plugin), present only
     * while the user is still a member of it. Named `orgId` because that is the claim
     * the `@lunora/jwt-auth` presets emit, so tenant-scoped code reads one name
     * whichever authority issued the identity.
     */
    orgId?: string;

    /**
     * better-auth's `admin()` column, comma-joined for several roles — what
     * `rls(policies, { roles })` and `auth.can(...)` read. Only an administrator can
     * write it.
     */
    role?: string;

    /**
     * The session's active team (`organization({ teams: { enabled: true } })`),
     * present only while it belongs to `orgId` and the user is still on it.
     */
    teamId?: string;

    userId: string;
};

/** The parts of a better-auth `getSession` result the identity is built from. */
interface SessionLike {
    session: { activeOrganizationId?: unknown; activeTeamId?: unknown; expiresAt?: unknown };
    user: { email?: unknown; id?: unknown; name?: unknown; role?: unknown };
}

const nonEmpty = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

/**
 * Reduce a better-auth session to the Lunora identity, taking `orgId` / `teamId`
 * from the session as-is. Unverified: {@link resolveSessionIdentity} is what the
 * wirings call.
 * @param session The `auth.api.getSession` result, or `null` when signed out.
 * @returns The identity, or `null` for an anonymous request.
 */
const identityFromSession = (session: SessionLike | null | undefined): SessionIdentity | null => {
    const userId = nonEmpty(session?.user.id);

    if (session === null || session === undefined || userId === undefined) {
        // eslint-disable-next-line unicorn/no-null -- `null` is the resolver contract's anonymous sentinel
        return null;
    }

    const { activeOrganizationId, activeTeamId, expiresAt } = session.session;
    const email = nonEmpty(session.user.email);
    const name = nonEmpty(session.user.name);
    const orgId = nonEmpty(activeOrganizationId);
    const role = nonEmpty(session.user.role);
    const teamId = nonEmpty(activeTeamId);

    return {
        ...(email === undefined ? {} : { email }),
        // better-auth hands back a `Date`; anything else means the adapter did not
        // hydrate it, and omitting beats guessing.
        ...(expiresAt instanceof Date ? { expiresAtMs: expiresAt.getTime() } : {}),
        ...(name === undefined ? {} : { name }),
        ...(orgId === undefined ? {} : { orgId }),
        ...(role === undefined ? {} : { role }),
        ...(teamId === undefined ? {} : { teamId }),
        userId,
    };
};

/**
 * Resolve a request's session to the Lunora identity: `ctx.auth.userId` plus the
 * claims `ctx.auth.getIdentity()` returns. Both built-in wirings (the D1 resolver
 * codegen emits and the auth Durable Object) call this.
 *
 * `orgId` / `teamId` are checked against the store before they are emitted, because
 * the session's `activeOrganizationId` / `activeTeamId` outlive the membership they
 * stand for. better-auth (1.7.7) clears them only on the caller's own current
 * session: a member removed by someone else, the other sessions of a member who
 * left, every member of a deleted organization, and anyone removed through
 * `createAuthAdmin` or SCIM (which write the tables directly, past any endpoint
 * hook) keep them. `setActiveOrganization` never clears `activeTeamId` either, so a
 * switch leaves the previous organization's team behind. Checking here covers every
 * one of those paths; clearing sessions on removal would cover only the endpoints,
 * and the session cookie cache would still serve the old value on top.
 *
 * The cost is one `member` read (plus `team` and `teamMember` when a team is active)
 * per resolution of a session that has an active organization, and the worker
 * memoises resolutions per credential, so the claim can lag a removal by up to that
 * memo window. A read that throws propagates rather than emitting an unchecked claim.
 * @param auth The better-auth instance.
 * @param headers The request headers carrying the session.
 * @returns The identity, or `null` for an anonymous request.
 */
const resolveSessionIdentity = async (auth: LunoraAuth, headers: Headers): Promise<SessionIdentity | null> => {
    const identity = identityFromSession(await auth.api.getSession({ headers }));

    if (identity === null || (identity.orgId === undefined && identity.teamId === undefined)) {
        return identity;
    }

    const { orgId, teamId, ...verified } = identity;

    if (orgId === undefined) {
        return verified;
    }

    const { adapter } = await auth.$context;
    const { userId } = identity;
    const [member, team, teamMember] = await Promise.all([
        adapter.findOne({
            model: "member",
            where: [
                { field: "organizationId", value: orgId },
                { field: "userId", value: userId },
            ],
        }),
        teamId === undefined
            ? undefined
            : adapter.findOne({
                  model: "team",
                  where: [
                      { field: "id", value: teamId },
                      { field: "organizationId", value: orgId },
                  ],
              }),
        teamId === undefined
            ? undefined
            : adapter.findOne({
                  model: "teamMember",
                  where: [
                      { field: "teamId", value: teamId },
                      { field: "userId", value: userId },
                  ],
              }),
    ]);

    if (!member) {
        return verified;
    }

    return { ...verified, orgId, ...(team && teamMember ? { teamId } : {}) };
};

export type { SessionIdentity, SessionLike };
export { identityFromSession, resolveSessionIdentity };
