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
    get: (id: unknown) => { fetch: (request: Request) => Promise<Response> };
    getByName?: (name: string) => { fetch: (request: Request) => Promise<Response> };
    idFromName: (name: string) => unknown;
}

/** Subset of the Worker environment the auth package consumes. */
export interface AuthEnv {
    [key: string]: unknown;
    /** D1 database that holds user records (not sessions). */
    DB: D1DatabaseLike;
    /** DurableObjectNamespace binding for SessionDO. */
    SESSION: SessionNamespaceLike;
}

export interface AuthUser {
    createdAt: number;
    email: string | null;
    id: string;
    name: string | null;
    provider: string;
    providerAccountId: string | null;
}

export interface AuthSession {
    createdAt: number;
    expiresAt: number;
    id: string;
    userId: string;
}

export type AuthState = { authenticated: true; session: AuthSession; user: AuthUser } | { authenticated: false; session: null; user: null };

export interface AuthProviderContext {
    cookieName: string;
    db: D1DatabaseLike;
    /**
     * Full Worker env so handlers can reach `env.SESSION` (the SessionDO
     * namespace) plus any provider-specific bindings. Late-bound — the
     * sentinel context used to enumerate route keys passes `undefined`.
     */
    env: AuthEnv;
    secret: string;
    sessionTtlSeconds: number;
}

export interface AuthProviderConfig {
    /** Unique provider id, e.g. `email-password`, `github`. */
    id: string;
    /** Routes contributed by the provider, keyed by `METHOD path`. */
    routes: (context: AuthProviderContext) => RouteMap;
}

export interface CirrusAuthOptions {
    cookieName?: string;
    providers: AuthProviderConfig[];
    secret: string;
    sessionTtlSeconds?: number;
}

export interface CirrusAuth {
    resolveAuth: (request: Request, env: AuthEnv) => Promise<AuthState>;
    routes: () => RouteMap;
}

// TODO(v0.2): rotate session ids on every authenticated request so that a
// leaked cookie expires within one round-trip.
export const DEFAULT_SESSION_TTL_SECONDS: number = 7 * 24 * 60 * 60;

export const DEFAULT_COOKIE_NAME: string = "cirrus_session";
