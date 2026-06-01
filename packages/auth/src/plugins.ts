/**
 * Re-exports of common better-auth plugins, surfaced as Cirrus-friendly
 * entry points.
 *
 * better-auth ships a rich plugin ecosystem (organizations, admin /
 * impersonation, magic-link, two-factor, …). Cirrus's stance is "thin
 * wrapper" — we don't reimplement the plugins, we just expose them under
 * `@cirrus/auth/plugins` so users don't need to know about better-auth's
 * subpath imports.
 *
 * # Wiring
 *
 * ```ts
 * import { createAuth } from "@cirrus/auth";
 * import { admin, organization } from "@cirrus/auth/plugins";
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
 * # Cirrus integration with `@cirrus/server` plugins
 *
 * To surface a better-auth plugin's API under `ctx.auth.&lt;key>` in
 * Cirrus procedures, wrap it as a `definePlugin` middleware:
 *
 * ```ts
 * import { definePlugin } from "@cirrus/server";
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
 * the plugin factories with a Cirrus-namespaced import path.
 */

export { admin } from "better-auth/plugins/admin";
export { anonymous } from "better-auth/plugins/anonymous";
export { bearer } from "better-auth/plugins/bearer";
export { customSession } from "better-auth/plugins/custom-session";
export { emailOTP } from "better-auth/plugins/email-otp";
export { genericOAuth } from "better-auth/plugins/generic-oauth";
export { jwt } from "better-auth/plugins/jwt";
export { magicLink } from "better-auth/plugins/magic-link";
export { multiSession } from "better-auth/plugins/multi-session";
export { oAuthProxy } from "better-auth/plugins/oauth-proxy";
export { oidcProvider } from "better-auth/plugins/oidc-provider";
export { organization } from "better-auth/plugins/organization";
export { phoneNumber } from "better-auth/plugins/phone-number";
export { siwe } from "better-auth/plugins/siwe";
export { twoFactor } from "better-auth/plugins/two-factor";
export { username } from "better-auth/plugins/username";
