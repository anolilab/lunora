import { DEFAULT_COOKIE, DEFAULT_HEADER, readToken } from "./read-token";
import type { AccessClaims, VerifyAccessJwtOptions } from "./types";
import { verifyAccessJwt } from "./verify";

/** Options for {@link accessAdminGate}; extends {@link VerifyAccessJwtOptions}. */
interface AccessAdminGateOptions extends VerifyAccessJwtOptions {
    /**
     * Cookie name carrying the Access JWT when the header is absent (browser
     * navigations). Default `"CF_Authorization"`.
     */
    cookieName?: string;

    /**
     * Request header carrying the Access JWT. Default `"cf-access-jwt-assertion"`
     * (matched case-insensitively).
     */
    headerName?: string;

    /**
     * Decide whether the **verified** claims authorize the Studio/admin plane —
     * e.g. `(claims) => claims.groups?.includes("ops") ?? false` or an email-domain
     * check. Required: there is no implicit grant, so a verified-but-unprivileged
     * identity is denied. Runs only after signature/issuer/audience/expiry pass.
     */
    isAdmin: (claims: AccessClaims) => boolean | Promise<boolean>;

    /**
     * Invoked when a token is present but fails verification. The gate still
     * returns `false` (fail-closed); this is your hook to log/observe. It is
     * **not** called when no token is present at all.
     */
    onError?: (error: unknown, request: Request) => void;
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
const accessAdminGate = (options: AccessAdminGateOptions): ((request: Request) => Promise<boolean>) => {
    const headerName = (options.headerName ?? DEFAULT_HEADER).toLowerCase();
    const cookieName = options.cookieName ?? DEFAULT_COOKIE;

    return async (request: Request): Promise<boolean> => {
        const token = readToken(request, headerName, cookieName);

        if (token === undefined) {
            return false;
        }

        try {
            const claims = await verifyAccessJwt(token, options);

            return await options.isAdmin(claims);
        } catch (error) {
            options.onError?.(error, request);

            return false;
        }
    };
};

export { accessAdminGate };
export type { AccessAdminGateOptions };
