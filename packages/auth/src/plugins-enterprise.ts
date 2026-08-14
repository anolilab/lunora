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

import type { SSOOptions } from "@better-auth/sso";
import { sso as betterAuthSso } from "@better-auth/sso";

/**
 * Warn once, at construction, when `sso()` is installed without
 * `domainVerification` explicitly enabled — the exposure `sso`'s docblock
 * below describes. This never runs per-request: it fires synchronously inside
 * the `sso()` call itself, once per call, so an app that constructs the
 * plugin once at worker setup sees the warning once.
 */
const warnIfDomainVerificationOff = (options: SSOOptions | undefined): void => {
    if (options?.domainVerification?.enabled === true) {
        return;
    }

    // eslint-disable-next-line no-console
    console.warn(
        "@lunora/auth: sso() is installed without `domainVerification: { enabled: true }` — an unverified " +
            "`domain` still routes sign-in, so any signed-in user can register an identity provider for a " +
            "domain they do not own. `/sso/register` is also session-only; narrow `providersLimit` if you " +
            "keep verification off. Pass `domainVerification: { enabled: true }` once your deployment can " +
            "prove domain ownership.",
    );
};

/**
 * Enterprise SSO — OIDC / OAuth2 / SAML 2.0 providers registered per email domain or
 * per organization, with `provisionUser` / `organizationProvisioning` hooks for
 * just-in-time account creation.
 *
 * Two defaults are worth setting deliberately, both documented on the package's docs
 * page: `domainVerification` is **off**, so an unverified `domain` still routes
 * sign-in; and `/sso/register` is session-only, so any signed-in user may register a
 * provider unless you narrow `providersLimit`. This wrapper does not change either
 * default — it only warns once, at construction, when `domainVerification` is not
 * explicitly enabled, naming both exposures. Every option is forwarded to
 * `@better-auth/sso` untouched.
 *
 * SAML loads on workerd but its assertion-verify path (pure-JS RSA) has not been
 * measured against a Worker CPU budget — treat OIDC/OAuth2 as the supported mode.
 * @experimental
 */
export const sso: typeof betterAuthSso = ((options?: SSOOptions) => {
    warnIfDomainVerificationOff(options);

    return betterAuthSso(options);
}) as typeof betterAuthSso;

/**
 * The OIDC provider configuration accepted by `registerSSOProvider` — exported so a
 * caller can type the config it builds (from env, a tenant record, …) before handing it
 * over.
 * @experimental
 */
export type { OIDCConfig } from "@better-auth/sso";
