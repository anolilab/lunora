import type { CirrusAuth } from "./create-auth.js";

/**
 * Default basePath used by better-auth's client + handler. Override via the
 * second argument if you mount the auth routes somewhere else.
 */
export const DEFAULT_AUTH_BASE_PATH: string = "/api/auth";

/**
 * Route an inbound `Request` to better-auth if the path falls under
 * `basePath`; otherwise return `null` so the caller can continue dispatching.
 *
 * Better-auth handles arbitrarily nested paths (`/api/auth/sign-in/email`,
 * `/api/auth/callback/github`, …), so we use prefix matching instead of the
 * exact-path map `createWorker` consumes for top-level routes.
 */
export const handleAuthRequest = async (auth: CirrusAuth, request: Request, basePath: string = DEFAULT_AUTH_BASE_PATH): Promise<Response | undefined> => {
    const url = new URL(request.url);

    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
        return undefined;
    }

    return auth.handler(request);
};
