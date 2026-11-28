/**
 * The template's tenant boundary, as plain functions.
 *
 * `lunora/server.ts` wires these into the worker; they live here, free of the
 * Worker env and of `_generated`, so a test can call them directly. If you edit
 * them, keep that boundary covered by a test of your own.
 */

/** The root shard: billing tables and `saas.me`, which every signed-in user needs. */
const ROOT_SHARD = "__root__";

/**
 * A caller may enter their own tenant's shard, plus the root shard. This decides
 * only where a caller may go, not which function runs there. Anonymous callers
 * get nothing, the root shard included.
 *
 * Every sharded table is `.shardBy("organizationId")`, so the shard key IS the
 * tenant id. The scheduler and queue consumers are exempt from this callback by
 * the runtime, so a missing identity here is always a real anonymous end user.
 */
const authorizeShard = ({ identity, shardKey }: { identity?: { activeOrganizationId?: string; userId?: string } | null; shardKey: string }): boolean => {
    if (!identity?.userId) {
        return false;
    }

    return shardKey === ROOT_SHARD || identity.activeOrganizationId === shardKey;
};

/** The slice of the better-auth instance `resolveIdentity` reads. */
interface IdentityAuth {
    $context: Promise<{
        adapter: {
            findOne<T>(query: { model: string; where: { field: string; value: string }[] }): Promise<T | null>;
        };
    }>;
    api: {
        getSession(input: { headers: Headers }): Promise<{
            session: { activeOrganizationId?: string | null; expiresAt?: unknown };
            user: { email?: string | null; id: string; name?: string | null; role?: string | null };
        } | null>;
    };
}

/**
 * The resolved identity: the claims `lunora/identity.ts` declares, plus the
 * undeclared ones the runtime, `saas.me` and `presence` read (`name`, `expiresAtMs`, `orgId`).
 */
const resolveIdentity = async (auth: IdentityAuth, request: Request): Promise<{ [claim: string]: unknown; userId: string } | null> => {
    const session = await auth.api.getSession({ headers: request.headers });

    if (!session?.user.id) {
        return null;
    }

    /*
     * `organization()` and `admin()` add `activeOrganizationId` and `role` at
     * runtime, but `createAuth` is declared to return the erased `LunoraAuth`,
     * so better-auth's plugin inference never reaches a consumer. The claims are
     * validated against `lunora/identity.ts` immediately afterwards, and a claim
     * set that does not match is rejected with a 401.
     */
    const { activeOrganizationId } = session.session;
    const { role } = session.user;

    /*
     * The caller's role in the organisation is NOT on the session — it lives on
     * better-auth's `member` row. The same lookup is the membership check: a
     * session can still name an organisation its user has been removed from,
     * and that must not become a tenant claim (it is what `authorizeShard`
     * admits the caller to).
     */
    const member = activeOrganizationId
        ? await (
              await auth.$context
          ).adapter.findOne<{ role: string }>({
              model: "member",
              where: [
                  { field: "organizationId", value: activeOrganizationId },
                  { field: "userId", value: session.user.id },
              ],
          })
        : null;
    const { expiresAt } = session.session;

    return {
        activeOrganizationId: member ? activeOrganizationId : undefined,
        appRole: role ?? undefined,
        email: session.user.email || undefined,
        // The socket credential expiry: without it a signed-out user keeps an
        // already-open WebSocket streaming their tenant's rows.
        ...(expiresAt instanceof Date ? { expiresAtMs: expiresAt.getTime() } : {}),
        name: session.user.name || undefined,
        // The same membership-checked tenant under the claim name `lunora/presence`
        // scopes its rooms by; without it every organisation shares one room.
        orgId: member ? activeOrganizationId : undefined,
        orgRole: member?.role,
        userId: session.user.id,
    };
};

export type { IdentityAuth };
export { authorizeShard, resolveIdentity };
