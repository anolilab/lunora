/**
 * Enterprise-auth plugins, split out from `@lunora/auth/plugins` because of what
 * they cost to install.
 *
 * `@better-auth/sso` statically imports `samlify` for its SAML path — which pulls
 * `xml-crypto`, `node-rsa`, and `@xmldom/xmldom` (~1.1 MB) plus a pure-JS crypto
 * supply chain — with no dynamic import to defer it. Tree-shaking keeps that out of
 * an app's *bundle*, but nothing keeps it out of an app's *install*, so it does not
 * belong in the barrel every `@lunora/auth` consumer imports.
 *
 * It is therefore an **optional peer dependency**: this subpath only resolves once
 * you install it yourself.
 *
 * ```sh
 * pnpm add "@better-auth/sso"
 * ```
 *
 * ```ts
 * import { createAuth } from "@lunora/auth";
 * import { sso } from "@lunora/auth/plugins/enterprise";
 *
 * export const auth = createAuth({
 *     secret: env.AUTH_SECRET,
 *     database: lunoraD1Adapter(env.DB),
 *     trustedOrigins: ["https://acme.okta.com"],
 *     plugins: [sso({ domainVerification: { enabled: true } })],
 * });
 * ```
 *
 * Pair it with `ssoClient` from `@lunora/auth/plugins/enterprise/client`.
 */

/**
 * Enterprise SSO — OIDC / OAuth2 / SAML 2.0 providers registered per email domain or
 * per organization, with `provisionUser` / `organizationProvisioning` hooks for
 * just-in-time account creation.
 *
 * Two defaults are worth setting deliberately, both documented on the package's docs
 * page: `domainVerification` is **off**, so an unverified `domain` still routes
 * sign-in; and `/sso/register` is session-only, so any signed-in user may register a
 * provider unless you narrow `providersLimit`.
 *
 * SAML loads on workerd but its assertion-verify path (pure-JS RSA) has not been
 * measured against a Worker CPU budget — treat OIDC/OAuth2 as the supported mode.
 * @experimental
 */
export { sso } from "@better-auth/sso";

/**
 * The OIDC provider configuration accepted by `registerSSOProvider` — exported so a
 * caller can type the config it builds (from env, a tenant record, …) before handing it
 * over.
 * @experimental
 */
export type { OIDCConfig } from "@better-auth/sso";
