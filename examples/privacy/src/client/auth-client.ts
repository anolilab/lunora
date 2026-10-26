import { createAuthClient } from "better-auth/react";

/**
 * The sign-in client. It uses the same origin as the Lunora client (`VITE_LUNORA_URL`, else this page's origin),
 * so the session cookie it sets is the one the Worker resolves the caller from.
 */
export const authClient = createAuthClient({ baseURL: (import.meta.env.VITE_LUNORA_URL as string | undefined) ?? globalThis.location.origin });
