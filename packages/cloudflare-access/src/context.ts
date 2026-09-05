import type { Middleware } from "@lunora/server";

import { isAccessIdentity, readIdentityGroups } from "./identity-groups";
import type { AccessClaims } from "./types";

/**
 * The slice of context {@link accessContext} reads: the `auth` facade every
 * Lunora ctx carries. `getIdentity()` returns the verified identity envelope —
 * `createAccessResolver`'s {@link import("./types").ResolvedAccessIdentity}
 * output, which carries the full claim set under `access` plus the promoted
 * `email` / `groups` / `commonName` fields.
 */
interface AccessContextInput {
    auth?: {
        getIdentity?: () => (Record<string, unknown> | null) | Promise<Record<string, unknown> | null>;
        userId?: string | null;
    };
}

/**
 * The typed, per-request `ctx.access` facade {@link accessContext} attaches. A
 * synchronous, Access-shaped read over the already-resolved identity — so a
 * handler reads `ctx.access.email` / `ctx.access.hasGroup("ops")` without an
 * `await` or a cast off the generic `ctx.auth.getIdentity()` envelope.
 */
interface AccessFacade {
    /** True when a verified Access identity is present on the request. */
    readonly authenticated: boolean;
    /** The full verified claim set, or `undefined` when anonymous. */
    readonly claims: AccessClaims | undefined;
    /** Service-token name (`common_name`), for machine callers; `undefined` otherwise. */
    readonly commonName: string | undefined;
    /** Verified SSO email; `undefined` for service tokens or anonymous requests. */
    readonly email: string | undefined;
    /** IdP group memberships — empty when none are emitted or the request is anonymous. */
    readonly groups: ReadonlyArray<string>;
    /** True when the verified groups include `group`. Always `false` when anonymous. */
    hasGroup: (group: string) => boolean;
    /** The stable caller id (`ctx.auth.userId`), or `undefined` when anonymous. */
    readonly userId: string | undefined;
}

/** The context shape {@link accessContext} produces — the input widened with `access`. */
interface AccessContextOutput extends AccessContextInput {
    access: AccessFacade;
}

/** Read a string claim, narrowing non-strings (and `undefined`) away. */
const stringClaim = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** The anonymous facade — no identity resolved. Every field empty, `hasGroup` always false. */
const ANONYMOUS_FACADE: AccessFacade = {
    authenticated: false,
    claims: undefined,
    commonName: undefined,
    email: undefined,
    groups: [],
    hasGroup: () => false,
    userId: undefined,
};

/** Build the typed facade from a resolved identity envelope (the resolver's output). */
const facadeFor = (identity: Record<string, unknown>, userId: string | undefined): AccessFacade => {
    // `createAccessResolver` nests the full verified claim set under `access`; its
    // presence is what marks this envelope as an *Access* identity. When it is
    // absent — a non-Access session resolved by another adapter under
    // `composeResolvers` (e.g. better-auth), or a custom `mapClaims` that dropped
    // `access` — there is no Access identity to surface, so `ctx.access` reads
    // anonymous rather than misreporting a foreign identity as Access-authenticated.
    if (!isAccessIdentity(identity)) {
        return ANONYMOUS_FACADE;
    }

    const claims = identity["access"] as AccessClaims;
    // Promoted fields may be overridden at the envelope top by a custom `mapClaims`;
    // prefer those, falling back to the verified claim set. `readIdentityGroups`
    // (shared with the resolver's role mapping) applies the same promoted-then-nested fallback
    // and string filtering; `?? []` keeps the facade's non-nullable `groups`.
    const groups = readIdentityGroups(identity) ?? [];

    return {
        authenticated: true,
        claims,
        commonName: stringClaim(identity["commonName"]) ?? stringClaim(claims.common_name),
        email: stringClaim(identity["email"]) ?? stringClaim(claims.email),
        groups,
        hasGroup: (group) => groups.includes(group),
        userId,
    };
};

/**
 * Build the `ctx.access` facade from a (possibly absent) resolved identity
 * envelope. Returns the anonymous facade when no identity is present, so callers
 * never null-check. Shared by {@link accessContext} and the codegen-wired global
 * `ctx.access` (which calls this synchronously from the resolved identity locals
 * at ctx-build time, so a global `ctx.access` adds only this object construction
 * per request — no extra I/O or re-verification).
 */
const accessFacade = (identity: Record<string, unknown> | null | undefined, userId: string | null | undefined): AccessFacade =>
    identity ? facadeFor(identity, userId ?? undefined) : ANONYMOUS_FACADE;

/**
 * Middleware that attaches a typed `ctx.access` facade derived from the verified
 * Cloudflare Access identity. It resolves `ctx.auth.getIdentity()` once and
 * exposes a **synchronous**, Access-shaped read — `ctx.access.email`,
 * `ctx.access.groups`, `ctx.access.hasGroup("ops")`, `ctx.access.claims` — so a
 * handler reads the verified identity ergonomically and with full typing instead
 * of casting off the generic `getIdentity()` envelope.
 *
 * When no identity is resolved (anonymous request) it attaches the anonymous
 * facade — `authenticated: false`, empty `groups`, `hasGroup` always `false` —
 * so reads stay safe without a null check, and authorization decisions still
 * fail closed.
 *
 * It does not gate the request; pair it with `rls(...)` (or
 * `rls(...)`) when you need enforcement. It only surfaces
 * the identity for branching inside a handler.
 *
 * ```ts
 * export const whoAmI = query
 *   .use(accessContext())
 *   .query(async ({ ctx }) => ({
 *       email: ctx.access.email,
 *       isOps: ctx.access.hasGroup("ops"),
 *   }));
 * ```
 */
const accessContext =
    <Context extends AccessContextInput>(): Middleware<Context, AccessContextOutput & Context> =>
    async ({ ctx, next }) => {
        const identity = await ctx.auth?.getIdentity?.();
        const access = accessFacade(identity, ctx.auth?.userId);

        return next({ ctx: { access } });
    };

export { accessContext, accessFacade };
export type { AccessContextInput, AccessContextOutput, AccessFacade };
