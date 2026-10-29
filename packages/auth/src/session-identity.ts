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
     * The session's active organization (`organization()` plugin). Named `orgId`
     * because that is the claim the `@lunora/jwt-auth` presets emit, so tenant-scoped
     * code reads one name whichever authority issued the identity.
     */
    orgId?: string;

    /**
     * better-auth's `admin()` column, comma-joined for several roles — what
     * `rls(policies, { roles })` and `auth.can(...)` read. Only an administrator can
     * write it.
     */
    role?: string;

    /** The session's active team (`organization({ teams: { enabled: true } })`). */
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
 * Reduce a better-auth session to the Lunora identity: `ctx.auth.userId` plus the
 * claims `ctx.auth.getIdentity()` returns.
 *
 * `orgId` / `teamId` exist only on a session whose app runs the organization plugin,
 * so no plugin check is needed here. They are read from the session the request
 * carries, so they follow `set-active` / create / accept-invitation on the next
 * request (see `org-session-refresh`); an open WebSocket keeps the identity it was
 * upgraded with until it reconnects.
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

export type { SessionIdentity, SessionLike };
export { identityFromSession };
