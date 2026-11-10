/**
 * Columns never handed back to a browser across any model: bearer credentials,
 * password hashes, OAuth tokens, and 2FA secrets. A denylist (not an allowlist)
 * so app-defined `additionalFields` still pass through; the names cover the
 * secret-bearing columns of better-auth core + the admin/organization/passkey/
 * two-factor plugin tables.
 */
const SENSITIVE_FIELDS: ReadonlySet<string> = new Set([
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

export default SENSITIVE_FIELDS;
