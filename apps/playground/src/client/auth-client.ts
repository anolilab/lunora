import { lunoraSessionSync } from "@lunora/auth/plugins/client";
import { createAuthClient } from "better-auth/react";

/**
 * Shared better-auth React client. Points at the worker's `/api/auth/*`
 * routes via the relative basePath so the SPA and the worker only need to
 * share an origin (same dev server in dev, same Cloudflare account in prod).
 *
 * `lunoraSessionSync()` tells the Lunora client after every sign-in and
 * sign-out: the session cookie is `HttpOnly`, so nothing else would, and its
 * live queries would keep serving the previous user's rows.
 */
export const authClient = createAuthClient({
    basePath: "/api/auth",
    plugins: [lunoraSessionSync()],
});
