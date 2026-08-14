import type { ExecutionContextLike } from "../../../shared/execution-context";
import readNativeIdentity from "./native";
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
 * `/_lunora/admin/*` plane (the Studio's HTTP + WS endpoints) in addition to — or
 * instead of — the static admin bearer, so the Studio can sit behind Cloudflare
 * Access.
 *
 * It authenticates the same two ways `createAccessResolver` does, platform
 * identity first: `context.access` when the Access policy is attached to the
 * Worker (nothing to configure, nothing to verify), otherwise the request's
 * `Cf-Access-Jwt-Assertion` JWT against your team JWKS (`teamDomain` + `aud`,
 * required together, for hostname-scoped Access applications).
 *
 * It is **fail-closed**: no identity, a token that fails verification, or an
 * `isAdmin` that returns `false` all resolve to `false` (the bearer remains the
 * only other path). Verification needs no `env` binding (static team-domain/aud
 * config + the remote JWKS over `fetch`), so the gate takes only the request and
 * its context and the runtime can evaluate it without threading async through
 * every admin route.
 *
 * ```ts
 * // Access policy attached to the Worker.
 * options.adminGate = accessAdminGate({
 *     isAdmin: (claims) => claims.groups?.includes("lunora-admins") ?? false,
 * });
 *
 * // Hostname-scoped Access application over /_lunora/admin.
 * options.adminGate = accessAdminGate({
 *     teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
 *     aud: env.CF_ACCESS_ADMIN_AUD,
 *     isAdmin: (claims) => claims.groups?.includes("lunora-admins") ?? false,
 * });
 * ```
 */
const accessAdminGate = (options: AccessAdminGateOptions): ((request: Request, context?: ExecutionContextLike) => Promise<boolean>) => {
    // Validate the static config eagerly so a half-configured deployment (an unset
    // teamDomain or aud) fails fast here at wiring time instead of denying every
    // admin request with no signal. `undefined` means "no JWT fallback", a legal
    // mode when the Worker itself is Access-protected.
    const jwtOptions = assertJwtFallbackOptions(options);

    return async (request: Request, context?: ExecutionContextLike): Promise<boolean> => {
        const claims = (await readNativeIdentity(context)) ?? (jwtOptions === undefined ? undefined : await verifyRequest(request, jwtOptions));

        return claims === undefined ? false : options.isAdmin(claims);
    };
};

export { accessAdminGate };
export type { AccessAdminGateOptions };
