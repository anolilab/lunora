import { ensureSchema, findSessionWithUser, readSessionCookie } from "../session.js";
import type { AuthProviderContext, RouteHandler } from "../types.js";
import { jsonResponse } from "./_shared.js";

/** `GET /auth/me` — returns the active user, or `{ authenticated: false }`. */
export const meHandler =
    (context: AuthProviderContext): RouteHandler =>
    async (request, env) => {
        await ensureSchema(context.db);

        const token = readSessionCookie(request, context.cookieName);

        if (!token) {
            return jsonResponse(200, { authenticated: false, user: null });
        }

        const result = await findSessionWithUser(env, token);

        if (!result) {
            return jsonResponse(200, { authenticated: false, user: null });
        }

        return jsonResponse(200, { authenticated: true, user: result.user, session: { id: result.session.id, expiresAt: result.session.expiresAt } });
    };
