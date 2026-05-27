import { ensureSchema, findSessionWithUser, readSessionCookie } from "./session.js";
import {
    DEFAULT_COOKIE_NAME,
    DEFAULT_SESSION_TTL_SECONDS,
    type AuthEnv,
    type AuthState,
    type CirrusAuth,
    type CirrusAuthOptions,
    type RouteMap,
} from "./types.js";

/**
 * Wires the configured providers' routes together and exposes the
 * `resolveAuth(req, env)` helper that queries/mutations call to populate
 * `ctx.auth`.
 *
 * Note: each call to `routes()` requires `env.DB` at request time — the
 * provider context binds late so the same `CirrusAuth` instance can serve
 * multiple Workers (e.g. dev + preview) with different bindings.
 */
export const createAuth = (options: CirrusAuthOptions): CirrusAuth => {
    if (!options.secret) {
        throw new Error("@cirrus/auth: `secret` is required");
    }

    if (!options.providers || options.providers.length === 0) {
        throw new Error("@cirrus/auth: at least one provider must be configured");
    }

    const sessionTtlSeconds = options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
    const cookieName = options.cookieName ?? DEFAULT_COOKIE_NAME;

    /**
     * Late-bound route map. We return wrappers so each request can pull the
     * `DB` + `SESSION` bindings off `env` at call time without forcing
     * callers to pass an env into `createAuth` itself.
     */
    const routes = (): RouteMap => {
        const map: RouteMap = {};

        for (const provider of options.providers) {
            const wrapper = (originalEnv: AuthEnv): ReturnType<typeof provider.routes> =>
                provider.routes({
                    secret: options.secret,
                    sessionTtlSeconds,
                    cookieName,
                    db: originalEnv.DB,
                    env: originalEnv,
                });

            // Eagerly enumerate keys against a sentinel context so callers can
            // mount them into their router. The actual handler closes over the
            // real env at request time. The sentinel never executes a handler,
            // so the dummy bindings below are only used for key enumeration.
            const sentinel = provider.routes({
                secret: options.secret,
                sessionTtlSeconds,
                cookieName,
                db: undefined as unknown as AuthEnv["DB"],
                env: undefined as unknown as AuthEnv,
            });

            for (const key of Object.keys(sentinel)) {
                map[key] = async (request, env, ctx) => {
                    const handlers = wrapper(env);
                    const handler = handlers[key];

                    if (!handler) {
                        return new Response("Not Found", { status: 404 });
                    }

                    return handler(request, env, ctx);
                };
            }
        }

        return map;
    };

    const resolveAuth = async (request: Request, env: AuthEnv): Promise<AuthState> => {
        if (!env?.DB || !env?.SESSION) {
            return { authenticated: false, user: null, session: null };
        }

        await ensureSchema(env.DB);

        const token = readSessionCookie(request, cookieName);

        if (!token) {
            return { authenticated: false, user: null, session: null };
        }

        const result = await findSessionWithUser(env, token);

        if (!result) {
            return { authenticated: false, user: null, session: null };
        }

        return { authenticated: true, user: result.user, session: result.session };
    };

    return { routes, resolveAuth };
};
