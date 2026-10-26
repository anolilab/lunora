import { createAuthClient } from "better-auth/react";

/**
 * The sign-in client, on the same origin as the page. The session cookie it sets is the one the Worker
 * resolves the caller from, so every Lunora call that follows is made as the signed-in user.
 */
export const authClient = createAuthClient({ baseURL: globalThis.location.origin });
