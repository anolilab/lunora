/**
 * The identity claim contract — added by `lunora registry add saas`.
 *
 * Codegen discovers exactly one `defineIdentity({ … })` call, and only in
 * `lunora/identity.ts`. It wires the contract into the runtime's trust
 * boundary, so every identity a resolver returns is validated before it becomes
 * `ctx.auth`, and it types what `ctx.auth.getIdentity()` resolves to —
 * `identity.activeOrganizationId` only compiles because the claim is declared
 * below. Note that claims are NOT flat properties on `ctx.auth`: `userId` is
 * the only one of those, and every other claim comes through `getIdentity()`.
 *
 * Why the kit needs this at all: organisations, members and invitations live in
 * better-auth's D1 tables, which are not Lunora tables. A function cannot read
 * them through `ctx.db` to answer "is this caller in this organisation?". So
 * the answer is carried on the identity instead — resolved once per request
 * from the session, validated here, and trusted by every function downstream.
 * That is why no function in `./saas/index.ts` takes an `organizationId`
 * argument: a client-supplied tenant id is a tenant-escape bug waiting to be
 * written, and the shard key comes from the verified claim only.
 *
 * `onInvalid: "reject"` fails a malformed claim set closed with a 401 rather
 * than silently downgrading it to anonymous. For a multi-tenant app that is the
 * right end of the trade: an anonymous downgrade turns "your credential is
 * broken" into "you have no organisation", which reads as data loss.
 *
 * Wire the matching resolver in your Worker entry, where `createWorker` is
 * called — `getAuth(env).api.getSession({ headers: request.headers })` returns
 * the better-auth session, and `session.activeOrganizationId` is the claim:
 *
 * ```ts
 * resolveIdentity: async (request) => {
 *     const session = await getAuth(env).api.getSession({ headers: request.headers });
 *     if (!session) return undefined;
 *     return {
 *         activeOrganizationId: session.session.activeOrganizationId ?? undefined,
 *         orgRole: session.session.activeOrganizationRole ?? undefined,
 *         userId: session.user.id,
 *     };
 * },
 * ```
 */
import { defineIdentity, v } from "lunorash/server";

/**
 * A NAMED export, not a default: codegen discovers the contract by walking
 * exported variable declarations in this file, so `export default
 * defineIdentity(…)` is never found and `ctx.auth` silently keeps its default
 * shape — the claims below then fail to compile at every read site.
 */
export const identity = defineIdentity(
    {
        /**
         * The tenant the caller is acting in — better-auth's
         * `session.activeOrganizationId`. Optional because a signed-in user
         * with no organisation yet is a real state (it is the onboarding
         * screen), not an error. Functions that need a tenant say so by
         * calling `requireOrganization`.
         */
        activeOrganizationId: v.optional(v.string()),

        /**
         * The caller's platform-wide role — better-auth's `admin()` plugin
         * writes `user.role`. Read only by the admin surface; an organisation
         * owner is not a platform admin, which is why this is a separate claim
         * from {@link orgRole} rather than a higher value of it.
         */
        appRole: v.optional(v.string()),

        /**
         * The caller's role in {@link activeOrganizationId} — `owner`,
         * `admin` or `member` under better-auth's defaults. Read by the
         * mutations that are owner/admin-only; never used to decide which
         * tenant's data is read, which is always the claim above.
         */
        orgRole: v.optional(v.string()),

        /** The better-auth user id. Required by the contract on every identity. */
        userId: v.string(),
    },
    { onInvalid: "reject" },
);
