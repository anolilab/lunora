import { hashPassword } from "../pbkdf2.js";
import { buildSessionCookie, createSession, createUser, ensureSchema, findUserByEmail } from "../session.js";
import type { AuthProviderContext, RouteHandler } from "../types.js";
import { jsonError, parseJsonBody, jsonResponse } from "./_shared.js";

/**
 * `POST /auth/signup` — creates an email/password account and signs the user in.
 * Body: `{ email, password, name? }`.
 */
export const signupHandler =
    (context: AuthProviderContext, options: { allowSignup: boolean }): RouteHandler =>
    async (request, env) => {
        if (!options.allowSignup) {
            return jsonError(403, "SIGNUP_DISABLED", "signup is disabled");
        }

        await ensureSchema(context.db);

        const body = await parseJsonBody(request);
        const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
        const password = typeof body?.password === "string" ? body.password : "";
        const name = typeof body?.name === "string" ? body.name : null;

        if (!email || !password) {
            return jsonError(400, "INVALID_INPUT", "email and password are required");
        }

        if (password.length < 8) {
            return jsonError(400, "WEAK_PASSWORD", "password must be at least 8 characters");
        }

        const existing = await findUserByEmail(context.db, email);

        if (existing) {
            // Return a generic "pending_verification" response so an attacker
            // cannot enumerate which emails are registered. Do NOT mutate any
            // user state for the existing account — only the legitimate owner
            // (via verification email in v0.2) gets to act on this email.
            return jsonResponse(201, { status: "pending_verification" });
        }

        const passwordHash = await hashPassword(password);
        const user = await createUser(context.db, {
            email,
            name,
            passwordHash,
            provider: "email-password",
            providerAccountId: null,
        });
        const { token, session } = await createSession(env, user.id, context.sessionTtlSeconds);

        return jsonResponse(
            201,
            { user, session: { id: session.id, expiresAt: session.expiresAt } },
            {
                "set-cookie": buildSessionCookie(context.cookieName, token, context.sessionTtlSeconds),
            },
        );
    };
