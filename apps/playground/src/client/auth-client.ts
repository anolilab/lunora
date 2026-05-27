import { createAuthClient } from "better-auth/react";

/**
 * Shared better-auth React client. Points at the worker's `/api/auth/*`
 * routes via the relative basePath so the SPA and the worker only need to
 * share an origin (same dev server in dev, same Cloudflare account in prod).
 */
export const authClient = createAuthClient({
    basePath: "/api/auth",
});
