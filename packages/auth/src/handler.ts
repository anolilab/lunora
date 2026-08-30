import type { LunoraAuth } from "./create-auth";

/**
 * Default basePath used by better-auth's client + handler. Override via the
 * second argument if you mount the auth routes somewhere else.
 */
export const DEFAULT_AUTH_BASE_PATH: string = "/api/auth";

/**
 * Whether `pathname` falls under the auth `basePath` at a segment boundary —
 * the shared predicate for both auth modes, so `/api/authorize` never counts
 * as an auth route for base `/api/auth`.
 *
 * Normalizes a caller-supplied trailing slash (e.g. "/api/auth/") so the
 * prefix match below doesn't become "/api/auth//" — which would never
 * match real nested routes like "/api/auth/get-session" and would silently
 * fall through to a 404.
 */
export const isAuthRoutePath = (pathname: string, basePath: string): boolean => {
    const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;

    return pathname === base || pathname.startsWith(`${base}/`);
};

/**
 * Route an inbound `Request` to better-auth if the path falls under
 * `basePath`; otherwise return `undefined` so the caller can continue dispatching.
 *
 * Better-auth handles arbitrarily nested paths (`/api/auth/sign-in/email`,
 * `/api/auth/callback/github`, …), so we use prefix matching instead of the
 * exact-path map `createWorker` consumes for top-level routes.
 */
export const handleAuthRequest = async (auth: LunoraAuth, request: Request, basePath: string = DEFAULT_AUTH_BASE_PATH): Promise<Response | undefined> => {
    const url = new URL(request.url);

    if (!isAuthRoutePath(url.pathname, basePath)) {
        return undefined;
    }

    return auth.handler(request);
};
