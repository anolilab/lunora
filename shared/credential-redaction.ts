/**
 * Credential masking shared by every telemetry and audit sink.
 *
 * Bundler-inlined source (see `shared/`), zero-dependency on purpose: the
 * request log / Logpush / span pipeline (`@lunora/observability`) and the auth
 * audit log (`@lunora/auth`) both need it, and neither may depend on the other.
 * Each caller still runs its own `@visulima/redact` rule set afterwards for
 * PII and value-shaped patterns; this module owns the part those rules got
 * wrong — WHICH key names and `name=value` pairs hold a credential.
 *
 * Why not `@visulima/redact` wildcard key rules (`*token*`): they match
 * substrings, so `tokenizer`, `secretary` and `passwordChangedAt` were masked
 * while numeric values under `password` / `otp` were kept; the last matching rule
 * wins there, so the choice could not be made per key. Keys here are split into
 * words (`stripeSecretKey` → `stripe secret key`) and judged by position.
 */

/** Words that, as the tail of a key, mark it as holding a credential. */
const SENSITIVE_WORDS = new Set([
    "auth",
    "authorization",
    "card",
    "cookie",
    "credential",
    "cvc",
    "cvv",
    "dsn",
    "hmac",
    "iban",
    "jwt",
    "otp",
    "pass",
    "passphrase",
    "passwd",
    "password",
    "pin",
    "pwd",
    "salt",
    "secret",
    "session",
    "sid",
    "sig",
    "signature",
    "ssn",
    "token",
]);

/** A word that only names a credential after one of these (`apiKey`, `privateKey`, not `shardKey`, `cacheKey`). */
const KEY_QUALIFIERS = new Set(["access", "api", "client", "encryption", "master", "private", "secret", "signing"]);

/** Two-word credentials whose parts are harmless alone. */
const COMPOUND_CREDENTIALS = new Set(["connection string", "database url"]);

/** Single lowercase words that are concatenated credential names (`apikey`, `accesstoken`). */
const CONCATENATED_SUFFIXES = [
    "accesskey",
    "apikey",
    "authorization",
    "cookie",
    "credential",
    "passphrase",
    "passwd",
    "password",
    "privatekey",
    "secret",
    "secretkey",
    "sessionid",
    "signature",
    "token",
];

/**
 * Words that may FOLLOW the sensitive word and still name the credential itself
 * (`passwordHash`, `sessionId`, `passwordConfirmation`). Anything else after it
 * names something about the credential (`passwordChangedAt`, `tokenType`,
 * `secretName`), which is not secret.
 */
const VALUE_WORDS = new Set([
    "again",
    "b64",
    "base64",
    "bytes",
    "confirm",
    "confirmation",
    "data",
    "digest",
    "encrypted",
    "hash",
    "hashed",
    "header",
    "hex",
    "id",
    "input",
    "key",
    "num",
    "number",
    "plain",
    "plaintext",
    "raw",
    "repeat",
    "str",
    "string",
    "text",
    "value",
]);

/** Keys shaped like a measurement: `maxTokens`, `tokenCount`, `tokenUsage`, `tokens`. */
const COUNT_LAST_WORDS = new Set(["count", "counts", "length", "limit", "limits", "size", "tokens", "total", "usage"]);
const COUNT_FIRST_WORDS = new Set(["max", "min", "num", "total"]);

/** Strings longer than this are truncated before any pattern runs, so one oversized arg cannot stall a Durable Object in regex work. */
const MAX_REDACTED_STRING_LENGTH = 4096;

const REDACTED = "<REDACTED>";

type KeyClass = "count-secret" | "none" | "secret";

const splitWords = (key: string): string[] =>
    key
        .replaceAll(/([a-z\d])([A-Z])/g, "$1 $2")
        .replaceAll(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z\d]+/)
        .filter((word) => word.length > 0);

const isSensitiveWord = (words: ReadonlyArray<string>, index: number): boolean => {
    const word = words[index] as string;
    const previous = index > 0 ? (words[index - 1] as string) : undefined;

    if (SENSITIVE_WORDS.has(word) || (word.endsWith("s") && SENSITIVE_WORDS.has(word.slice(0, -1)))) {
        return true;
    }

    if (previous !== undefined && ((word === "key" && KEY_QUALIFIERS.has(previous)) || COMPOUND_CREDENTIALS.has(`${previous} ${word}`))) {
        return true;
    }

    return CONCATENATED_SUFFIXES.some((suffix) => word.length > suffix.length && word.endsWith(suffix));
};

/**
 * Classify a key name. `"secret"`: the value is a credential. `"count-secret"`:
 * a measurement of credentials (`maxTokens`, `tokenUsage`) — numbers and nested
 * objects are kept, bare strings are not. `"none"`: leave it to the caller's rules.
 */
const classifyKey = (key: string): KeyClass => {
    const words = splitWords(key);

    if (words.length === 0) {
        return "none";
    }

    const isCount = COUNT_LAST_WORDS.has(words.at(-1) as string) || COUNT_FIRST_WORDS.has(words[0] as string);

    for (let index = words.length - 1; index >= 0; index -= 1) {
        if (isSensitiveWord(words, index)) {
            if (isCount) {
                return "count-secret";
            }

            return words.slice(index + 1).every((word) => VALUE_WORDS.has(word)) ? "secret" : "none";
        }
    }

    return "none";
};

/** Mask a value held under a credential key: everything but a boolean or `null` (no credential is one). */
const maskValue = (value: unknown): unknown => (typeof value === "boolean" || value === null || value === undefined ? value : REDACTED);

/** A URL's query, fragment and userinfo, which carry signatures, tokens and passwords. */
const stripUrl = (url: string): string => {
    const scheme = url.indexOf("://") + 3;
    const authorityEnd = url.slice(scheme).search(/[/?#]/);
    const authority = authorityEnd === -1 ? url.slice(scheme) : url.slice(scheme, scheme + authorityEnd);
    const rest = authorityEnd === -1 ? "" : url.slice(scheme + authorityEnd);
    const host = authority.slice(authority.lastIndexOf("@") + 1);
    const query = rest.search(/[?#]/);

    return `${url.slice(0, scheme)}${host}${query === -1 ? rest : rest.slice(0, query)}`;
};

const URL_IN_TEXT = /\b[a-z][\d+.a-z-]{1,15}:\/\/[^\s"'<>()[\]{}]+/gi;

/** `Authorization: Basic …` and friends. Bearer is caught by the callers' rules, Basic was not. */
const AUTH_SCHEME = /\b(Basic|Digest)\s+[\w+/=.~-]{4,}/g;

/** A `name` + separator (`=`, `:`, with optional quotes around the name). The value is read separately, only when the name is a credential. */
const ASSIGNMENT_NAME = /(?<![\w.-])(["']?)([A-Za-z_][\w.-]{0,63})\1[ \t]{0,4}[:=][ \t]{0,4}/g;

/**
 * The value after a credential's separator: an auth scheme and its token
 * (`Authorization: Bearer …` must lose both words, or the token outlives its
 * scheme), a quoted run (closing quote optional), or a bare token.
 */
const ASSIGNMENT_VALUE = /(?:basic|bearer|digest|token)\s+[^\s"&'),;\]}]+|"[^\n"]*"?|'[^\n']*'?|[^\s"&'),;\]}]+/iy;

/**
 * Mask `name=value` / `name: value` / `"name":"value"` pairs whose name is a
 * credential, keeping the name and any quotes. Scans left to right and only
 * consumes a value when it masks one, so a benign `Error: token=abc` still has
 * its inner `token=abc` examined.
 */
const maskAssignments = (text: string): string => {
    let output = "";
    let cursor = 0;

    ASSIGNMENT_NAME.lastIndex = 0;

    for (let match = ASSIGNMENT_NAME.exec(text); match !== null; match = ASSIGNMENT_NAME.exec(text)) {
        const kind = classifyKey(match[2] as string);
        const valueStart = match.index + match[0].length;

        ASSIGNMENT_VALUE.lastIndex = valueStart;

        const value = kind === "none" ? null : ASSIGNMENT_VALUE.exec(text);

        if (value === null || (kind === "count-secret" && /^["']?[\d.]+["']?$/.test(value[0]))) {
            ASSIGNMENT_NAME.lastIndex = Math.max(valueStart, match.index + 1);

            continue;
        }

        const quote = value[0].startsWith('"') || value[0].startsWith("'") ? (value[0][0] as string) : "";

        output += `${text.slice(cursor, valueStart)}${quote}${REDACTED}${quote}`;
        cursor = valueStart + value[0].length;
        ASSIGNMENT_NAME.lastIndex = cursor;
    }

    return output + text.slice(cursor);
};

const maskString = (value: string): string => {
    const capped = value.length > MAX_REDACTED_STRING_LENGTH ? `${value.slice(0, MAX_REDACTED_STRING_LENGTH)}…[truncated]` : value;

    return maskAssignments(capped.replaceAll(URL_IN_TEXT, stripUrl).replaceAll(AUTH_SCHEME, `$1 ${REDACTED}`));
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const prototype = Object.getPrototypeOf(value) as unknown;

    return prototype === Object.prototype || prototype === null;
};

const MAX_DEPTH = 32;

const walk = (value: unknown, seen: WeakSet<object>, depth: number, maskStrings: boolean): unknown => {
    if (typeof value === "string") {
        return maskStrings ? REDACTED : maskString(value);
    }

    if (Array.isArray(value) || isPlainObject(value)) {
        if (seen.has(value) || depth >= MAX_DEPTH) {
            return REDACTED;
        }

        seen.add(value);

        const result = Array.isArray(value)
            ? value.map((item) => walk(item, seen, depth + 1, maskStrings))
            : Object.fromEntries(
                  Object.entries(value).map(([key, item]) => {
                      const kind = classifyKey(key);

                      if (kind === "secret") {
                          return [key, maskValue(item)];
                      }

                      // A measurement of credentials: numbers stay, containers are
                      // walked, and a bare string under it (or in an array under it,
                      // `accessTokens: ["…"]`) is the credential itself.
                      return [key, walk(item, seen, depth + 1, kind === "count-secret" && (typeof item === "string" || Array.isArray(item)))];
                  }),
              );

        seen.delete(value);

        return result;
    }

    return value;
};

/**
 * Mask credentials in `value` — by key name on objects (any depth), and by
 * `name=value`, `Basic …` and URL shape in strings (query, fragment and userinfo
 * dropped) — and cap every string at {@link MAX_REDACTED_STRING_LENGTH}.
 * Returns a copy; the input is never mutated. Class instances, `Map`s and
 * `Error`s are returned as-is for the caller's redactor to handle.
 */
const maskCredentials = (value: unknown): unknown => walk(value, new WeakSet(), 0, false);

export { classifyKey, maskCredentials, MAX_REDACTED_STRING_LENGTH };
