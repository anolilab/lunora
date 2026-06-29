import type { AccessClaims, RequestVerifyOptions } from "./types";
import { verifyRequest } from "./verify";

/** Options for {@link accessAdminGate}; extends {@link RequestVerifyOptions}. */
interface AccessAdminGateOptions extends RequestVerifyOptions {
    /**
     * Decide whether the **verified** claims authorize the Studio/admin plane —
     * e.g. `(claims) => claims.groups?.includes("ops") ?? false` or an email-domain
     * check. Required: there is no implicit grant, so a verified-but-unprivileged
     * identity is denied. Runs only after signature/issuer/audience/expiry pass.
     */
    isAdmin: (claims: AccessClaims) => boolean | Promise<boolean>;
}

/**
 * Build an admin gate for `@lunora/runtime`'s `WorkerOptions.adminGate`: a
 * request-only predicate that verifies the request's `Cf-Access-Jwt-Assertion`
 * JWT and applies your `isAdmin(claims)` test. When it resolves `true` the
 * request authorizes the `/_lunora/admin/*` plane (the Studio's HTTP + WS
 * endpoints) in addition to — or instead of — the static admin bearer, so the
 * Studio can sit behind Cloudflare Access.
 *
 * It is **fail-closed**: a missing token, a token that fails verification, or an
 * `isAdmin` that returns `false` all resolve to `false` (the bearer remains the
 * only other path). Verification needs no `env` binding (static team-domain/aud
 * config + the remote JWKS over `fetch`), so the gate takes only the request and
 * the runtime can evaluate it without threading async through every admin route.
 *
 * ```ts
 * options.adminGate = accessAdminGate({
 *     teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
 *     aud: env.CF_ACCESS_ADMIN_AUD,
 *     isAdmin: (claims) => claims.groups?.includes("lunora-admins") ?? false,
 * });
 * ```
 */
const accessAdminGate =
    (options: AccessAdminGateOptions): ((request: Request) => Promise<boolean>) =>
    async (request: Request): Promise<boolean> => {
        const claims = await verifyRequest(request, options);

        return claims === undefined ? false : options.isAdmin(claims);
    };

export { accessAdminGate };
export type { AccessAdminGateOptions };
