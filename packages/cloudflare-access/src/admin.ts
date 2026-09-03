import { LunoraError } from "@lunora/errors";

import type { ExecutionContextLike } from "../../../shared/execution-context";
import readPlatformIdentity from "./platform-identity";
import type { AccessClaims, AccessJwtFallbackOptions } from "./types";
import { assertJwtFallbackOptions, verifyRequest } from "./verify";

/** Options for {@link accessAdminGate}; extends {@link AccessJwtFallbackOptions}. */
interface AccessAdminGateOptions extends AccessJwtFallbackOptions {
    /**
     * Decide whether the **verified** claims authorize the Studio/admin plane —
     * e.g. `(claims) => claims.groups?.includes("ops") ?? false` or an email-domain
     * check. Required: there is no implicit grant, so a verified-but-unprivileged
     * identity is denied. Runs only after the caller is authenticated.
     */
    isAdmin: (claims: AccessClaims) => boolean | Promise<boolean>;
}

/**
 * Build an admin gate for `@lunora/runtime`'s `WorkerOptions.adminGate`: a
 * predicate that authenticates the caller through Cloudflare Access and applies
 * your `isAdmin(claims)` test. When it resolves `true` the request authorizes the
 * admin **HTTP** plane (`/_lunora/admin/*` plus `/_lunora/migrate`) in addition
 * to — or instead of — the static admin bearer, so the Studio's pages can sit
 * behind Cloudflare Access.
 *
 * It does NOT cover `/_lunora/ws`, which is not an admin path: the runtime never
 * evaluates the gate there. The Studio's live views authenticate their socket
 * with a sub-token minted at `/_lunora/admin/ws-token`, signed with the static
 * admin token — so with no `LUNORA_ADMIN_TOKEN` configured, minting refuses
 * (`ADMIN_TOKEN_NOT_CONFIGURED`) and every live panel fails while the HTTP pages
 * work. Configure both.
 *
 * It accepts exactly one proof, and **which one is your choice, not the
 * platform's**:
 *
 * - Configure `teamDomain` + `aud` and the request's `Cf-Access-Jwt-Assertion`
 * JWT is the only thing accepted. This is the stricter setup, and the point of
 * the `aud`: it proves the caller came through the *specific* Access application
 * you put in front of `/_lunora/admin`, not merely through some application in
 * the same Cloudflare team.
 * - Configure neither and the Worker's own Access identity (`context.access`) is
 * accepted, for a deployment whose Access policy is attached to the Worker.
 *
 * Note this is the **opposite** precedence to `createAccessResolver`, which
 * prefers the platform identity. That is deliberate. A policy attached to the
 * Worker is typically broad — "anyone at the company", covering every route and
 * preview URL — while a configured admin `aud` is deliberately narrow. Letting
 * the broad one satisfy a gate you scoped with the narrow one would widen the
 * admin plane to everyone the Worker policy admits, silently, the moment that
 * policy was attached.
 *
 * It is **fail-closed**: no identity, a token that fails verification, or an
 * `isAdmin` that returns `false` all resolve to `false` (the bearer remains the
 * only other path). Verification needs no `env` binding (static team-domain/aud
 * config + the remote JWKS over `fetch`), so the gate takes only the request and
 * its context and the runtime can evaluate it without threading async through
 * every admin route.
 *
 * ```ts
 * // A dedicated Access application over /_lunora/admin — the JWT is the only proof.
 * options.adminGate = accessAdminGate({
 *     teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
 *     aud: env.CF_ACCESS_ADMIN_AUD,
 *     isAdmin: (claims) => claims.groups?.includes("lunora-admins") ?? false,
 * });
 *
 * // Access policy attached to the Worker — `isAdmin` is the whole boundary, so
 * // make it at least as strict as a dedicated admin application would have been.
 * options.adminGate = accessAdminGate({
 *     isAdmin: (claims) => claims.groups?.includes("lunora-admins") ?? false,
 * });
 * ```
 */
const accessAdminGate = (options: AccessAdminGateOptions): ((request: Request, context?: ExecutionContextLike) => Promise<boolean>) => {
    // `isAdmin` is the whole authorization boundary, and the type alone does not
    // enforce it: JS callers and `as` casts reach here without one, and a missing
    // one used to throw a bare TypeError *inside* the gate — which the runtime
    // catches and degrades to "no grant". The Studio then silently fell back to
    // the bearer with nothing logged. Fail at wiring time, by name, instead.
    if (typeof options.isAdmin !== "function") {
        throw new LunoraError(
            "INTERNAL",
            "accessAdminGate: `isAdmin` is required and must be a function — it is the entire admin boundary, so there is no implicit grant. " +
                'Pass e.g. `isAdmin: (claims) => claims.groups?.includes("lunora-admins") ?? false`.',
        );
    }

    // Validate the static config eagerly so a half-configured deployment fails
    // fast here at wiring time instead of denying every admin request with no
    // signal. `undefined` means "no JWT configured", which selects the platform
    // identity below rather than adding a fallback to it.
    const jwtOptions = assertJwtFallbackOptions(options);

    return async (request: Request, context?: ExecutionContextLike): Promise<boolean> => {
        const claims = jwtOptions === undefined ? await readPlatformIdentity(context) : await verifyRequest(request, jwtOptions);

        if (claims === undefined) {
            return false;
        }

        // Narrowed to an exact `true`, not returned as-is. `isAdmin` is the whole
        // admin boundary and it is app code: an untyped caller returning the
        // matched group object, a truthy count, or `{ ok: false }` would otherwise
        // be handed to the runtime's gate as a grant.
        const verdict: unknown = await options.isAdmin(claims);

        return verdict === true;
    };
};

export { accessAdminGate };
export type { AccessAdminGateOptions };
