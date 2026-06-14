import { createAuthClient } from "better-auth/react";

/**
 * Shared better-auth React client for the hosted studio. Points at the
 * control-plane Worker's `/api/auth/*` routes via the relative basePath, so the
 * SPA and the Worker only need to share an origin (same dev server in dev, same
 * Cloudflare account in prod).
 */
export const authClient = createAuthClient({
    basePath: "/api/auth",
});
