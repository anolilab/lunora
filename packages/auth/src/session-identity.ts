import { SENSITIVE_FIELDS } from "./admin";
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
    /** App-declared user columns forwarded by {@link resolveSessionIdentity}'s `claims`. */
    [claim: string]: string | number | boolean | undefined;

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
    user: { [column: string]: unknown; email?: unknown; id?: unknown; name?: unknown; role?: unknown };
}

const nonEmpty = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

/** Claims the session already writes; an app claim with one of these names is ignored, never overwritten. */
const RESERVED_CLAIMS: ReadonlySet<string> = new Set(["email", "expiresAtMs", "name", "orgId", "role", "teamId", "userId"]);

/**
 * The JSON-safe value of one app-declared user column, or `undefined` when the
 * column must not be forwarded: a `null` or unset column (an older user created
 * before the column existed), a secret-bearing column, a reserved claim name, or a
 * value that does not survive JSON (objects, arrays, functions).
 * @param column The column name as declared in the auth config's `user.additionalFields`.
 * @param value The column's value on the session user.
 * @returns The claim value, or `undefined` to omit it.
 */
const forwardableClaim = (column: string, value: unknown): string | number | boolean | undefined => {
    if (RESERVED_CLAIMS.has(column) || SENSITIVE_FIELDS.has(column)) {
        return undefined;
    }

    if (typeof value === "string" || typeof value === "boolean") {
        return value;
    }

    if (typeof value === "number") {
        return Number.isFinite(value) ? value : undefined;
    }

    // better-auth hands back a `Date` for date columns; a claim is JSON, so send the ISO string.
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
    }

    return undefined;
};

/** The app-declared claims a session user carries, keyed by column name. */
const forwardedClaims = (user: SessionLike["user"], claims: ReadonlyArray<string>): Record<string, string | number | boolean> => {
    const out: Record<string, string | number | boolean> = {};

    for (const column of claims) {
        const value = forwardableClaim(column, user[column]);

        if (value !== undefined) {
            out[column] = value;
        }
    }

    return out;
};

/**
 * Reduce a better-auth session to the Lunora identity, taking `orgId` / `teamId`
 * from the session as-is. Unverified: {@link resolveSessionIdentity} is what the
 * wirings call.
 * @param session The `auth.api.getSession` result, or `null` when signed out.
 * @returns The identity, or `null` for an anonymous request.
 */
const identityFromSession = (session: SessionLike | null | undefined, claims: ReadonlyArray<string> = []): SessionIdentity | null => {
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
        ...forwardedClaims(session.user, claims),
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
const resolveSessionIdentity = async (auth: LunoraAuth, headers: Headers, claims: ReadonlyArray<string> = []): Promise<SessionIdentity | null> => {
    const identity = identityFromSession(await auth.api.getSession({ headers }), claims);

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

export type { SessionIdentity };
export { identityFromSession, resolveSessionIdentity };
