import { getDummyPbkdf2Hash, verifyPassword } from "../pbkdf2.js";
import { buildSessionCookie, createSession, ensureSchema, findUserByEmail } from "../session.js";
import type { AuthProviderContext, RouteHandler } from "../types.js";
import { jsonError, parseJsonBody, jsonResponse } from "./_shared.js";

/** `POST /auth/signin` — verifies an email/password pair and issues a session. */
export const signinHandler =
    (context: AuthProviderContext): RouteHandler =>
    async (request, env) => {
        await ensureSchema(context.db);

        const body = await parseJsonBody(request);
        const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
        const password = typeof body?.password === "string" ? body.password : "";

        if (!email || !password) {
            return jsonError(400, "INVALID_INPUT", "email and password are required");
        }

        const user = await findUserByEmail(context.db, email);

        if (!user || !user.passwordHash) {
            // Run verifyPassword against a dummy hash so that the response
            // timing for "unknown email" matches "wrong password". Prevents
            // user-enumeration via timing analysis.
            const dummy = await getDummyPbkdf2Hash();

            await verifyPassword(password, dummy);

            return jsonError(401, "INVALID_CREDENTIALS", "incorrect email or password");
        }

        const ok = await verifyPassword(password, user.passwordHash);

        if (!ok) {
            return jsonError(401, "INVALID_CREDENTIALS", "incorrect email or password");
        }

        const { token, session } = await createSession(env, user.id, context.sessionTtlSeconds);
        const { passwordHash: _passwordHash, ...publicUser } = user;

        return jsonResponse(
            200,
            { user: publicUser, session: { id: session.id, expiresAt: session.expiresAt } },
            {
                "set-cookie": buildSessionCookie(context.cookieName, token, context.sessionTtlSeconds),
            },
        );
    };
