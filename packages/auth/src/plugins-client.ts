/**
 * Client-side counterparts to the server plugins re-exported from
 * `@lunora/auth/plugins`, surfaced under `@lunora/auth/plugins/client`.
 *
 * better-auth plugins come in two halves: a **server** plugin you pass to
 * `betterAuth()` (re-exported from `@lunora/auth/plugins`) and a **client**
 * plugin you pass to `createAuthClient()`. Both halves must be registered for a
 * plugin's endpoints, inferred types, and client actions (e.g.
 * `authClient.twoFactor.*`, `authClient.organization.*`, the `twoFactorRedirect`
 * sign-in flow) to exist. This module is the client half so consumers don't have
 * to reach into better-auth's `better-auth/client/plugins` subpath directly.
 *
 * # Wiring
 *
 * ```ts
 * import { createAuthClient } from "better-auth/client"; // or a framework adapter
 * import { organizationClient, twoFactorClient } from "@lunora/auth/plugins/client";
 *
 * export const authClient = createAuthClient({
 *     baseURL: import.meta.env.VITE_AUTH_URL,
 *     plugins: [
 *         organizationClient(),
 *         twoFactorClient({ onTwoFactorRedirect: () => location.assign("/2fa") }),
 *     ],
 * });
 * ```
 *
 * Keep the client plugin list in parity with the server `plugins` array passed
 * to `createAuth`: a server plugin without its client counterpart leaves
 * those actions untyped/unavailable, and vice-versa.
 */

// Passkey/WebAuthn ships its client half under `@better-auth/passkey/client`,
// mirroring the server `passkey` re-export from `@lunora/auth/plugins`.
export { passkeyClient } from "@better-auth/passkey/client";
// SCIM's client half is for *managing* provisioning from your own admin UI (the
// IdV drives the `/Users` endpoints server-to-server with a bearer token, not
// through this client).
export { scimClient } from "@better-auth/scim/client";
// `ssoClient` adds `authClient.signIn.sso({ email | domain | providerId })` — the
// domain-based provider lookup is the whole point of enterprise SSO, and it is
// unavailable without registering this half.
export { ssoClient } from "@better-auth/sso/client";
export { adminClient } from "better-auth/client/plugins";
export { anonymousClient } from "better-auth/client/plugins";
export { customSessionClient } from "better-auth/client/plugins";
export { deviceAuthorizationClient } from "better-auth/client/plugins";
export { emailOTPClient } from "better-auth/client/plugins";
export { genericOAuthClient } from "better-auth/client/plugins";
// `inferAdditionalFields` / `inferOrgAdditionalFields` — type helpers that
// re-sync custom server fields onto the client so `authClient` stays typed.
export { inferAdditionalFields, inferOrgAdditionalFields } from "better-auth/client/plugins";
export { jwtClient } from "better-auth/client/plugins";
export { lastLoginMethodClient } from "better-auth/client/plugins";
export { magicLinkClient } from "better-auth/client/plugins";
export { multiSessionClient } from "better-auth/client/plugins";
export { oidcClient } from "better-auth/client/plugins";
export { oneTimeTokenClient } from "better-auth/client/plugins";
export { organizationClient } from "better-auth/client/plugins";
export { phoneNumberClient } from "better-auth/client/plugins";
export { siweClient } from "better-auth/client/plugins";
export { twoFactorClient } from "better-auth/client/plugins";
export { usernameClient } from "better-auth/client/plugins";
