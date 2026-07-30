/**
 * One `createAuth({...})` call's configuration snapshot — the shared input for
 * the five `auth_*` security lints (`auth_trusted_origins_wildcard`,
 * `auth_csrf_check_disabled`, `auth_secure_cookies_disabled`,
 * `auth_email_verification_disabled`, `auth_session_freshage_zero`).
 *
 * The feeder matches the `createAuth` call by callee name and, when its config
 * argument is a static object literal, reads the handful of nested facts each
 * lint cares about. An opaque config (a top-level spread, or a non-object-literal
 * argument) is recorded with `analyzable: false` and every boolean fact left at
 * its SAFE (not-flagged) value, so a config assembled elsewhere can't be flagged
 * on a key it may or may not set. Produced by the codegen feeder; runtime
 * callers don't supply it, so the auth-config lints find nothing there.
 */
export interface AdvisorAuthConfig {
    /**
     * `true` when the call's config argument was a static object literal the
     * feeder could read. `false` when the config was opaque (a variable, spread,
     * call result, or missing argument) — every lint below skips such a config.
     */
    analyzable: boolean;
    /** `advanced.disableCSRFCheck === true`. */
    disableCsrfCheck: boolean;
    /** `emailAndPassword.enabled === true`. */
    emailPasswordEnabled: boolean;
    /** The exported binding name enclosing the `createAuth(...)` call. */
    exportName: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** 1-based line of the `createAuth(...)` call, or `0` when unknown. */
    line: number;
    // eslint-disable-next-line no-secrets/no-secrets -- the dotted config-path in the doc comment, not a credential
    /** `emailAndPassword.requireEmailVerification === true` present. */
    requireEmailVerification: boolean;

    /**
     * `plugins` includes `scim(...)` while `database` is `lunoraD1Adapter` /
     * `lunoraAuthAdapter` — neither exposes native transactions, which `@better-auth/scim`
     * refuses to serve without.
     */
    scimOnNonTransactionalAdapter: boolean;
    /** `advanced.useSecureCookies === false`. */
    secureCookiesDisabled: boolean;
    /** `session.freshAge === 0` (explicit literal). */
    sessionFreshAgeZero: boolean;
    /** `trustedOrigins` array literal contains a `"*"` element. */
    trustedOriginsWildcard: boolean;
}
