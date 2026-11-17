/**
 * The rules an app-declared user column must pass to reach `ctx.auth` as a claim.
 * Shared by `@lunora/auth` (which forwards the claims at runtime) and `@lunora/codegen`
 * (which types them and refuses the ones the runtime would drop), so the two cannot
 * disagree about which names count.
 */

/**
 * Columns never handed back to a browser across any model: bearer credentials,
 * password hashes, OAuth tokens, and 2FA secrets. A denylist (not an allowlist)
 * so app-defined `additionalFields` still pass through; the names cover the
 * secret-bearing columns of better-auth core + the admin/organization/passkey/
 * two-factor plugin tables.
 */
export const SENSITIVE_FIELDS: ReadonlySet<string> = new Set([
    "accessToken",
    "backupCodes",
    "idToken",
    "password",
    "publicKey",
    "refreshToken",
    "secret",
    "token",
    "tokenHash",
]);

/**
 * Claims the session already writes, or that the runtime reads as credential expiry
 * or policy roles. An app column with one of these names is ignored, never overwritten.
 * `__proto__` is here because assigning it on a plain object never creates an own
 * property, so a column of that name could never arrive as a claim.
 */
export const RESERVED_CLAIMS: ReadonlySet<string> = new Set([
    "__proto__",
    "email",
    "exp",
    "expiresAtMs",
    "iat",
    "name",
    "nbf",
    "orgId",
    "role",
    "roles",
    "sub",
    "teamId",
    "userId",
]);

/** Most claim names one declaration may carry; a longer list is truncated. */
export const MAX_CLAIM_NAMES = 32;

/** A column name a claim may carry: an identifier, bounded in length. */
export const CLAIM_NAME = /^[A-Z_]\w{0,63}$/i;
