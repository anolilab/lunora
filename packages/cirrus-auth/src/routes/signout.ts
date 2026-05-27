import { buildClearCookie, ensureSchema, readSessionCookie, revokeSession } from "../session.js";
import type { AuthProviderContext, RouteHandler } from "../types.js";
import { jsonResponse } from "./_shared.js";

/** `POST /auth/signout` — clears the cookie and removes the session from SessionDO. */
export const signoutHandler =
    (context: AuthProviderContext): RouteHandler =>
    async (request, env) => {
        await ensureSchema(context.db);

        const token = readSessionCookie(request, context.cookieName);

        if (token) {
            await revokeSession(env, token);
        }

        return jsonResponse(
            200,
            { ok: true },
            {
                "set-cookie": buildClearCookie(context.cookieName),
            },
        );
    };
