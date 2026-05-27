import { createAuthClient } from "better-auth/react";

/**
 * Shared better-auth React client for the blog example. Targets the
 * worker's `/api/auth/*` routes mounted by `@cirrus/auth`.
 */
export const authClient = createAuthClient({
    basePath: "/api/auth",
});
