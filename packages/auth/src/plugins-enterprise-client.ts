import type { ssoClient } from "@better-auth/sso/client";

/**
 * Client halves of the enterprise-auth plugins — the counterpart to
 * `@lunora/auth/plugins/enterprise`, split out for the same reason (see that module).
 *
 * Unlike the server half, the client half is cheap: `@better-auth/sso/client` pulls in
 * no SAML code at all. It still lives here rather than in the general client barrel,
 * because both halves resolve from the same optional peer — putting one in the barrel
 * would break every consumer that hasn't installed it.
 *
 * ```ts
 * import { createAuthClient } from "better-auth/react";
 * import { ssoClient } from "@lunora/auth/plugins/enterprise/client";
 *
 * export const authClient = createAuthClient({ plugins: [ssoClient()] });
 *
 * // The domain lookup is the point: the user types a work email, not a provider name.
 * await authClient.signIn.sso({ email: "someone@acme.com", callbackURL: "/dashboard" });
 * ```
 */

/**
 * Adds `authClient.signIn.sso({ email | domain | providerId })`. Registering the
 * server `sso` plugin without this leaves those actions unavailable and untyped.
 * @experimental
 */
export { ssoClient } from "@better-auth/sso/client";

/**
 * The plugin instance `ssoClient()` returns. Exported so an app can type the array it
 * passes to `createAuthClient` when it assembles plugins conditionally.
 * @experimental
 */
export type SSOClientPlugin = ReturnType<typeof ssoClient>;
