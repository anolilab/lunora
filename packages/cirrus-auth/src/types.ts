import type { D1DatabaseLike } from "@cirrus/d1";

/** Routes mounted by `auth.routes()` keyed by `METHOD path`. */
export type RouteHandler = (request: Request, env: AuthEnv, ctx: unknown) => Promise<Response>;

export type RouteMap = Record<string, RouteHandler>;

/**
 * Structural projection of `DurableObjectNamespace` for the `SESSION`
 * binding. Mirrors the same shape used by `@cirrus/runtime`'s shard
 * resolver — `getByName` is preferred when present.
 */
export interface SessionNamespaceLike {
    idFromName: (name: string) => unknown;
    get: (id: unknown) => { fetch: (request: Request) => Promise<Response> };
    getByName?: (name: string) => { fetch: (request: Request) => Promise<Response> };
}

/** Subset of the Worker environment the auth package consumes. */
export interface AuthEnv {
    /** D1 database that holds user records (not sessions). */
    DB: D1DatabaseLike;
    /** DurableObjectNamespace binding for SessionDO. */
    SESSION: SessionNamespaceLike;
    [key: string]: unknown;
}

export interface AuthUser {
    id: string;
    email: string | null;
    name: string | null;
    provider: string;
    providerAccountId: string | null;
    createdAt: number;
}

export interface AuthSession {
    id: string;
    userId: string;
    expiresAt: number;
    createdAt: number;
}

export type AuthState = { authenticated: true; user: AuthUser; session: AuthSession } | { authenticated: false; user: null; session: null };

export interface AuthProviderContext {
    secret: string;
    sessionTtlSeconds: number;
    cookieName: string;
    db: D1DatabaseLike;
    /**
     * Full Worker env so handlers can reach `env.SESSION` (the SessionDO
     * namespace) plus any provider-specific bindings. Late-bound — the
     * sentinel context used to enumerate route keys passes `undefined`.
     */
    env: AuthEnv;
}

export interface AuthProviderConfig {
    /** Unique provider id, e.g. `email-password`, `github`. */
    id: string;
    /** Routes contributed by the provider, keyed by `METHOD path`. */
    routes: (context: AuthProviderContext) => RouteMap;
}

export interface CirrusAuthOptions {
    secret: string;
    providers: AuthProviderConfig[];
    sessionTtlSeconds?: number;
    cookieName?: string;
}

export interface CirrusAuth {
    routes(): RouteMap;
    resolveAuth(request: Request, env: AuthEnv): Promise<AuthState>;
}

// TODO(v0.2): rotate session ids on every authenticated request so that a
// leaked cookie expires within one round-trip.
export const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export const DEFAULT_COOKIE_NAME = "cirrus_session";
