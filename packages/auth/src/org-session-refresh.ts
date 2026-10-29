/**
 * Keep better-auth's session cookie cache in step with organization membership.
 *
 * `createAuth` turns `session.cookieCache` on by default, so `getSession` (and
 * with it every `resolveIdentity`) answers from the signed `session_data` cookie
 * until it expires. better-auth's organization plugin writes the session's
 * `activeOrganizationId` / `activeTeamId` on several endpoints without
 * re-issuing that cookie: `/organization/create`, `/organization/accept-invitation`
 * (which on the single-team path even writes a cache cookie carrying the *old*
 * organization), `/organization/delete`, `/organization/leave`,
 * `/organization/remove-member` on yourself, and the `get-organization` /
 * `get-full-organization` reads that clear a membership that no longer exists.
 * Without this hook the caller's next request still sees the previous
 * organization for up to the cache `maxAge`.
 *
 * A session other than the caller's (removing another member) cannot be
 * refreshed from here — that user's cookie is not on this response — and stays
 * stale until their cache expires.
 */
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, isAPIError } from "better-auth/api";
import { setCookieCache } from "better-auth/cookies";

import type { LunoraAuthOptions } from "./create-auth";

const ORG_SESSION_REFRESH_ID = "lunora-org-session-refresh";

/** Endpoints that move the caller's `activeOrganizationId` without re-issuing the cache cookie. */
const MOVES_ACTIVE_ORGANIZATION = new Set([
    "/organization/accept-invitation",
    "/organization/create",
    "/organization/delete",
    "/organization/leave",
    "/organization/remove-member",
]);

/** Reads that clear a lost membership and then answer FORBIDDEN. */
const CLEARS_ON_FORBIDDEN = new Set(["/organization/get-full-organization", "/organization/get-organization"]);

const orgSessionRefresh = (): BetterAuthPlugin => {
    return {
        hooks: {
            after: [
                {
                    handler: createAuthMiddleware(async (context) => {
                        const token = await context.getSignedCookie(context.context.authCookies.sessionToken.name, context.context.secret);

                        if (typeof token !== "string" || token === "") {
                            return undefined;
                        }

                        // The endpoint's own view of the session predates its write (and may
                        // itself have come from the stale cache), so the store is re-read.
                        const fresh = await context.context.internalAdapter.findSession(token);

                        if (!fresh) {
                            return undefined;
                        }

                        const dontRememberMe = await context.getSignedCookie(context.context.authCookies.dontRememberToken.name, context.context.secret);

                        // Only the cache cookie is stale; `setSessionCookie` would also re-sign the
                        // token cookie and fire `setNewSession`, which other hooks read as a sign-in.
                        // Appended after any cache cookie the endpoint wrote itself (accept-invitation's
                        // single-team path writes one carrying the previous organization), so it wins.
                        await setCookieCache(context, fresh, Boolean(dontRememberMe));

                        // Any other value would replace the endpoint's response body.
                        return undefined;
                    }),
                    matcher: (context) => {
                        if (context.context.options.session?.cookieCache?.enabled !== true || context.path === undefined) {
                            return false;
                        }

                        return MOVES_ACTIVE_ORGANIZATION.has(context.path) || (CLEARS_ON_FORBIDDEN.has(context.path) && isAPIError(context.context.returned));
                    },
                },
            ],
        },
        id: ORG_SESSION_REFRESH_ID,
    };
};

/** Append {@link orgSessionRefresh} when the options run the organization plugin. */
const withOrgSessionRefresh = (options: LunoraAuthOptions): LunoraAuthOptions => {
    const plugins = options.plugins ?? [];

    // `resolveAuthOptions` runs more than once on some paths (the auth DO resolves for
    // its schema, then `createAuth` resolves again), so appending must be idempotent.
    if (!plugins.some((plugin) => plugin.id === "organization") || plugins.some((plugin) => plugin.id === ORG_SESSION_REFRESH_ID)) {
        return options;
    }

    return { ...options, plugins: [...plugins, orgSessionRefresh()] };
};

export { orgSessionRefresh, withOrgSessionRefresh };
