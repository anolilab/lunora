/**
 * Re-exports of common better-auth plugins, surfaced as Lunora-friendly
 * entry points.
 *
 * better-auth ships a rich plugin ecosystem (organizations, admin /
 * impersonation, magic-link, two-factor, …). Lunora's stance is "thin
 * wrapper" — we don't reimplement the plugins, we just expose them under
 * `@lunora/auth/plugins` so users don't need to know about better-auth's
 * subpath imports.
 *
 * # Wiring
 *
 * ```ts
 * import { createAuth } from "@lunora/auth";
 * import { admin, organization } from "@lunora/auth/plugins";
 *
 * export const auth = createAuth({
 *     database: env.DB,
 *     secret: env.AUTH_SECRET,
 *     plugins: [
 *         organization({ allowUserToCreateOrganization: true }),
 *         admin({ defaultRole: "user" }),
 *     ],
 * });
 *
 * // server-side queries can reach the plugin api via `auth.api.*`:
 * await auth.api.createOrganization({ body: { name: "Acme" }, headers });
 * ```
 *
 * # Lunora integration with `@lunora/server` plugins
 *
 * To surface a better-auth plugin's API under `ctx.auth.<key>` in
 * Lunora procedures, wrap it as a `definePlugin` middleware:
 *
 * ```ts
 * import { definePlugin } from "@lunora/server";
 * import { auth } from "./auth";
 *
 * export const orgPlugin = definePlugin("org", {
 *     middleware: async ({ ctx, next }) => {
 *         const orgApi = auth.api; // typed by better-auth
 *         return next({ ctx: { ...ctx, auth: { ...ctx.auth, org: orgApi } } });
 *     },
 * });
 * ```
 *
 * The auth instance is the source of truth; this module just hands you
 * the plugin factories with a Lunora-namespaced import path.
 */

/**
 * SCIM 2.0 server — directory-driven user provisioning, so an enterprise IdP can
 * create/update/deactivate users without anyone signing in. Users only (no
 * `/Groups`), and deactivation needs the `admin` plugin. See the package docs for
 * the setup and its security-relevant defaults.
 */

/**
 * Close self-serve sign-up to invited addresses only: an account is created only
 * for an email an administrator has invited with `createSignUpInvitation`.
 * Declares the `signUpInvitation` table it reads. Lunora's own, not a better-auth
 * re-export.
 */
export type { InviteOnlyOptions, SignUpInvitation } from "./invite-only";
export { inviteOnly } from "./invite-only";

/**
 * Publish which plugins and social providers this deployment enabled, at
 * `GET {basePath}/ui-config`, so an auth UI configures itself instead of making
 * you restate the list client-side. Lunora's own, not a better-auth re-export.
 */
export type { UiConfigOptions, UiConfigOrganization, UiConfigPayload } from "./ui-config";
export { uiConfig } from "./ui-config";

// Programmatic API keys: non-session credentials a user or service mints for
// scripts, CI, and machine clients, with their own expiry, rate limits, and
// permissions. Its own package rather than a `better-auth/plugins` subpath.
export { apiKey } from "@better-auth/api-key";

// OAuth-protected Model Context Protocol servers — pairs with `@lunora/mcp`,
// whose `createAuthedMcpFetchHandler` mounts a Lunora MCP server behind
// `requireMcpAuth`. better-auth 1.7 moved these out of its core barrel into
// `@better-auth/mcp` and renamed `withMcpAuth` to `requireMcpAuth`.
//
// `requireMcpAuth(auth, handler, opts)` protects a route on the SAME deployment
// as the authorization server: it reads issuer/JWKS/resource defaults off the
// auth instance. `createMcpProtectedRequestHandler(options, handler)` is the
// split-deployment form — a resource server that only holds verification
// config, no auth instance. It replaced 1.7.0-rc's `mcpHandler`, which the GA
// release dropped.
export { createMcpProtectedRequestHandler, mcp, requireMcpAuth } from "@better-auth/mcp";

// Turn your app into an OAuth/OpenID Connect provider other apps sign in with.
// Replaces the `oidcProvider` plugin, which better-auth deprecated in 1.6 and
// removed in 1.7; the factory is named `oauthProvider` in its new home.
export { oauthProvider } from "@better-auth/oauth-provider";
// The OAuth device authorization grant (RFC 8628) as an extension to the
// provider above, for clients with no browser or no keyboard. 1.7 split it out
// of `oauthProvider` into its own opt-in plugin, so a provider that does not
// want the device endpoints no longer serves them. Distinct from the
// `deviceAuthorization` re-export below, which is the device grant for THIS
// app's own sign-in rather than for third-party OAuth clients.
export { oauthDeviceAuthorization } from "@better-auth/oauth-provider";
export { passkey } from "@better-auth/passkey";
export { scim } from "@better-auth/scim";

// `captcha` (Cloudflare Turnstile, reCAPTCHA, hCaptcha, captchafox), `lastLoginMethod`
// and `oneTap` have no dedicated `better-auth/plugins/<name>` subpath in better-auth's
// exports map — they ship only via the `better-auth/plugins` barrel, so they are
// re-exported from there rather than a per-plugin subpath like the others.
//
// `lastLoginMethod` records which method a user last signed in with, so an auth UI can
// highlight it on the next visit; `oneTap` is Google One Tap. Both had their client
// halves in `./plugins-client` already, and a client plugin without its server half is
// inert — these close that gap.
export { captcha, lastLoginMethod, oneTap } from "better-auth/plugins";
// Access-control builder (`createAccessControl`) — the companion to the `admin`
// and `organization` plugins for defining custom roles/permissions.
export { createAccessControl } from "better-auth/plugins/access";
export { admin } from "better-auth/plugins/admin";
export { anonymous } from "better-auth/plugins/anonymous";
export { bearer } from "better-auth/plugins/bearer";
export { customSession } from "better-auth/plugins/custom-session";
export { deviceAuthorization } from "better-auth/plugins/device-authorization";
export { emailOTP } from "better-auth/plugins/email-otp";
export { genericOAuth } from "better-auth/plugins/generic-oauth";
export { haveIBeenPwned } from "better-auth/plugins/haveibeenpwned";
export { jwt } from "better-auth/plugins/jwt";
export { magicLink } from "better-auth/plugins/magic-link";
export { multiSession } from "better-auth/plugins/multi-session";
export { oAuthProxy } from "better-auth/plugins/oauth-proxy";
export { oneTimeToken } from "better-auth/plugins/one-time-token";
export { organization } from "better-auth/plugins/organization";
export { phoneNumber } from "better-auth/plugins/phone-number";
export { siwe } from "better-auth/plugins/siwe";
export { twoFactor } from "better-auth/plugins/two-factor";
export { username } from "better-auth/plugins/username";
