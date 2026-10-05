/**
 * Shared better-auth React client for the hosted studio.
 *
 * Re-exported from the copy-in auth-UI client rather than constructed here, so the
 * app has exactly ONE client. `createAuthClient` returns a stateful proxy that owns
 * session state and its subscriptions; building a second instance for the auth
 * screens would give the sign-in card and the dashboard separate views of the same
 * session, so a sign-in or sign-out could land in one and not the other.
 *
 * `lunora/auth-ui/client.ts` is the seam that decides which better-auth plugins the
 * app has (and tells the cards, which cannot introspect the proxy). This file stays
 * as the import path the rest of `src/client` already uses.
 */
export { authClient } from "../../lunora/auth-ui/client";
