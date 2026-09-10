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
const SENSITIVE_KEY = /authorization|password|passwd|secret|credential|(?:api|access|private|client|encryption)[_-]?key|token|\bcookie\b|set-cookie|session/i;

/** True when a field/attribute key names something secret and its value should be scrubbed. */
export const isSensitiveKey = (key: string): boolean => SENSITIVE_KEY.test(key);

// Secret-shaped SUBSTRINGS in free text (a recorded prompt/completion), where
// there is no key to match on. Each alternative is independently bounded — no
// nested quantifiers, so no ReDoS. Case-insensitive.
const SECRET_IN_TEXT = new RegExp(
    [
        String.raw`(?<bearer>bearer\s+)[\w.~+/=-]{8,}`, // Authorization: Bearer <token>
        String.raw`\bsk-[a-z\d]{16,}\b`, // OpenAI-style api keys
        String.raw`\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{6,}`, // JWTs
        String.raw`\bAKIA[a-z\d]{16}\b`, // AWS access key ids
        String.raw`(?<kv>(?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*)\S+`, // key=value / key: value
    ].join("|"),
    "gi",
);

/**
 * Scrub secret-shaped substrings from free text (a recorded generation
 * prompt/completion), where {@link redactRecord}'s key-based match can't reach.
 * Replaces bearer tokens, api keys, JWTs, and `secret=…` pairs with a placeholder;
 * a `bearer `/`key=` prefix is preserved so the line still reads. `undefined`
 * passes through.
 */
export const redactText = (text: string | undefined): string | undefined => {
    if (text === undefined) {
        return undefined;
    }

    // The regex has two prefix-capturing alternatives — a named `bearer ` and a
    // named `key=` group — so keep whichever one matched (the other alternatives
    // capture nothing) and drop only the secret that follows. Named groups arrive
    // as the final `groups` argument, robust to alternatives being reordered.
    return text.replaceAll(SECRET_IN_TEXT, (...arguments_: unknown[]) => {
        const groups = arguments_.at(-1) as { bearer?: string; kv?: string } | undefined;

        return `${groups?.bearer ?? groups?.kv ?? ""}${REDACTED}`;
    });
};

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
