/**
 * PII redaction for ingested telemetry. Span attributes and log fields are
 * stored verbatim, and an app (or a third-party OTel exporter) may put a
 * credential in one — an `Authorization` header, a session cookie, an API key.
 * This scrubs any attribute/field whose KEY names a secret, replacing its value
 * with a placeholder, before the ingest persists it. Pure + unit-tested; applied
 * in `decodeObservations`/`decodeLogRecords`.
 *
 * Key-based (not value-based) on purpose: matching arbitrary secret *values* in
 * free text is unreliable, but a sensitive *key* is a strong, cheap signal, and
 * it's where credentials predictably land in structured telemetry.
 */

/** The placeholder a redacted value is replaced with. */
export const REDACTED = "[redacted]";

// A key is sensitive when it contains any of these tokens (case-insensitive).
// Simple alternation — no nested quantifiers, so it can't ReDoS.
//
// `token` and `secret` match as SUBSTRINGS (not `\b`-bounded), because `_`/camelCase
// have no word boundary — so `auth_token`, `id_token`, `authToken`, `bearerToken`
// are caught, where a bounded `\btoken\b` silently leaked them. `key` stays scoped
// to credential-ish prefixes so an innocuous `shard_key` / `idempotency_key` is not
// redacted.
const SENSITIVE_KEY =
    /authorization|password|passwd|secret|credential|(?:api|access|private|secret|client|encryption)[-_]?key|token|\bcookie\b|set-cookie|session/i;

/** True when a field/attribute key names something secret and its value should be scrubbed. */
export const isSensitiveKey = (key: string): boolean => SENSITIVE_KEY.test(key);

/**
 * Return a copy of `record` with every sensitive-keyed value replaced by
 * {@link REDACTED}. Returns the original reference untouched when nothing
 * matched (no needless allocation), or `undefined` passed through.
 */
export const redactRecord = <T extends Record<string, unknown>>(record: T | undefined): T | undefined => {
    if (record === undefined) {
        return undefined;
    }

    let redacted = false;
    const out: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(record)) {
        if (isSensitiveKey(key)) {
            out[key] = REDACTED;
            redacted = true;
        } else {
            out[key] = value;
        }
    }

    return (redacted ? out : record) as T;
};
