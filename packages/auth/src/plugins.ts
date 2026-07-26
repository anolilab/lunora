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
 * To surface a better-auth plugin's API under `ctx.auth.&lt;key>` in
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

export { passkey } from "@better-auth/passkey";

/**
 * SCIM 2.0 **server** — directory-driven user provisioning, so an enterprise IdP
 * (Okta, Entra) can create/update/deactivate users without anyone signing in.
 *
 * `@better-auth/scim` is **Users-only**: it serves `/Users`, not `/Groups`, so
 * group→role sync is not covered by adding this plugin. Two of its behaviours need
 * companion plugins — `active: false` deactivation needs `admin`, and org-scoped
 * provisioning needs `organization`.
 */
export { scim } from "@better-auth/scim";

/**
 * Enterprise SSO — OIDC / OAuth2 / SAML 2.0 providers registered per email domain
 * or per organization, with `provisionUser` / `organizationProvisioning` hooks for
 * just-in-time account creation.
 *
 * **Bundle note.** This module statically imports `samlify` (and `node:crypto`'s
 * `X509Certificate`) for its SAML path, so those land in the bundle even when only
 * the OIDC mode is configured. The module does load and construct in workerd —
 * `__tests__/workerd/enterprise-auth.workerd.test.ts` is the standing proof — but
 * the SAML *code path* (ACS assertion verify, pure-JS RSA) has not been measured
 * against a Worker CPU budget here. Treat OIDC/OAuth2 as the supported mode and
 * SAML as unverified until that spike exists; upstream better-auth#10343 tracks a
 * pluggable remote executor as the sanctioned edge path for SAML.
 */
export { sso } from "@better-auth/sso";
// `captcha` (Cloudflare Turnstile, reCAPTCHA, hCaptcha, captchafox) has no
// dedicated `better-auth/plugins/<name>` subpath in better-auth's exports map —
// it ships only via the `better-auth/plugins` barrel, so it is re-exported from
// there rather than a per-plugin subpath like the others.
export { captcha } from "better-auth/plugins";
// `mcp` + `withMcpAuth` (OAuth-protected Model Context Protocol servers — pairs
// with `@lunora/mcp`) have no dedicated subpath; both ship via the barrel.
export { mcp, withMcpAuth } from "better-auth/plugins";
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
export { oidcProvider } from "better-auth/plugins/oidc-provider";
export { oneTimeToken } from "better-auth/plugins/one-time-token";
export { organization } from "better-auth/plugins/organization";
export { phoneNumber } from "better-auth/plugins/phone-number";
export { siwe } from "better-auth/plugins/siwe";
export { twoFactor } from "better-auth/plugins/two-factor";
export { username } from "better-auth/plugins/username";
