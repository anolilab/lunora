import { createAuthClient } from "better-auth/react";

/**
 * The sign-in client. It uses this page's origin, the same as the Lunora client, so the session cookie it sets is the
 * one the Worker resolves the caller from.
 */
export const authClient = createAuthClient({ baseURL: globalThis.location.origin });
