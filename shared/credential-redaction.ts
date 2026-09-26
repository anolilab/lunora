/**
 * Credential masking shared by every telemetry and audit sink.
 *
 * Bundler-inlined source (see `shared/`), zero-dependency on purpose: the
 * request log / Logpush / span pipeline (`@lunora/observability`) and the auth
 * audit log (`@lunora/auth`) both need it, and neither may depend on the other.
 * The request log and the audit log still run their `@visulima/redact` rule
 * sets afterwards for PII; span, event, link and metric attributes use this
 * module alone, because those rules cost ~20 µs per call on the Durable
 * Object's only thread.
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
    "bearer",
    "card",
    "cc",
    "cookie",
    "credential",
    "cvc",
    "cvv",
    "dsn",
    "hmac",
    "hotp",
    "iban",
    "jwt",
    "kek",
    "mnemonic",
    "otp",
    "pass",
    "passcode",
    "passphrase",
    "passwd",
    "password",
    "pem",
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
    "totp",
    "verifier",
]);

/**
 * Sensitive words that also name ordinary app data (`cards` on a kanban board,
 * `sessions` in a calendar, map `pins`, a transit `pass`). Under these a string
 * or number is still masked, but an object or array is walked instead, so the
 * credentials inside it are masked and the rest of the data survives.
 */
const SCALAR_ONLY_WORDS = new Set(["card", "pass", "pin", "session"]);

/** A word that only names a credential after one of these (`apiKey`, `privateKey`, not `shardKey`, `cacheKey`). */
const KEY_QUALIFIERS = new Set(["access", "api", "client", "encryption", "master", "priv", "private", "secret", "signing"]);

/** A `code` is a credential only after one of these (`otpCode`, `recoveryCode`); a bare `code` / `errorCode` / `statusCode` is not. */
const CODE_QUALIFIERS = new Set([
    "2fa",
    "auth",
    "authorization",
    "backup",
    "factor",
    "hotp",
    "mfa",
    "otp",
    "pin",
    "recovery",
    "reset",
    "security",
    "totp",
    "verification",
    "verify",
]);

/** Two-word credentials whose parts are harmless alone. */
const COMPOUND_CREDENTIALS = new Set(["card no", "connection string", "database url", "one time"]);

/** Single lowercase words that are (or end in) a concatenated credential name (`apikey`, `useraccesstoken`). */
const CONCATENATED_SUFFIXES = [
    "accesskey",
    "apikey",
    "authorization",
    "cookie",
    "credential",
    "mfacode",
    "otpcode",
    "passcode",
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
 * (`passwordHash`, `sessionId`, `passwordConfirmation`, `secret_key_base`).
 * Anything else after it names something about the credential
 * (`passwordChangedAt`, `tokenType`, `secretName`), which is not secret.
 */
const VALUE_WORDS = new Set([
    "again",
    "b64",
    "base",
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
    "no",
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

/** Longest single string examined; the rest is cut before any pattern runs. */
const MAX_REDACTED_STRING_LENGTH = 4096;

/**
 * Characters examined per redacted VALUE (an args object, a log field bag), not
 * per string: 256 strings of 4 KiB each would otherwise cost seconds in the
 * callers' PII regexes. Strings met after it is spent become {@link BUDGET_MARKER}.
 */
const MAX_REDACTED_TOTAL_LENGTH = 16_384;

const REDACTED = "<REDACTED>";

const BUDGET_MARKER = "[redaction budget exceeded]";

type KeyClass = "count-secret" | "none" | "scalar-secret" | "secret";

const splitWords = (key: string): string[] =>
    key
        .replaceAll(/([a-z\d])([A-Z])/g, "$1 $2")
        .replaceAll(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z\d]+/)
        .filter((word) => word.length > 0);

const singular = (word: string): string => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word);

/** The sensitive word at `index` (singular), or `undefined`. */
const sensitiveWordAt = (words: ReadonlyArray<string>, index: number): string | undefined => {
    const word = singular(words[index] as string);
    const previous = index > 0 ? singular(words[index - 1] as string) : undefined;

    if (SENSITIVE_WORDS.has(word)) {
        return word;
    }

    if (previous !== undefined) {
        if (word === "key" && KEY_QUALIFIERS.has(previous)) {
            return "key";
        }

        if (word === "code" && CODE_QUALIFIERS.has(previous)) {
            return "code";
        }

        if (COMPOUND_CREDENTIALS.has(`${previous} ${word}`)) {
            return `${previous} ${word}`;
        }
    }

    return CONCATENATED_SUFFIXES.some((suffix) => word.endsWith(suffix)) ? word : undefined;
};

/**
 * Classify a key name. `"secret"`: the value is a credential. `"scalar-secret"`:
 * a credential when it is a string or number, app data when it is a container
 * (see {@link SCALAR_ONLY_WORDS}). `"count-secret"`: a measurement of
 * credentials (`maxTokens`, `tokenUsage`) — numbers and nested objects are kept,
 * bare strings are not. `"none"`: not a credential key.
 */
const classifyKey = (key: string): KeyClass => {
    const words = splitWords(key);

    if (words.length === 0) {
        return "none";
    }

    const isCount = COUNT_LAST_WORDS.has(words.at(-1) as string) || COUNT_FIRST_WORDS.has(words[0] as string);

    for (let index = words.length - 1; index >= 0; index -= 1) {
        const sensitive = sensitiveWordAt(words, index);

        if (sensitive !== undefined) {
            if (isCount) {
                return "count-secret";
            }

            if (!words.slice(index + 1).every((word) => VALUE_WORDS.has(word))) {
                return "none";
            }

            return SCALAR_ONLY_WORDS.has(sensitive) && index === words.length - 1 ? "scalar-secret" : "secret";
        }
    }

    return "none";
};

/** Mask a value held under a credential key: everything but a boolean or `null` (no credential is one). */
const maskValue = (value: unknown): unknown => (typeof value === "boolean" || value === null || value === undefined ? value : REDACTED);

/**
 * A URL with its query, fragment and userinfo dropped — they carry signatures,
 * tokens and passwords. The userinfo ends at the LAST `@` before the query,
 * provided a `user:password` colon precedes it that is not a `host:port`, so a
 * password holding an unencoded `/` (`u:p/ss@host`) is still found. When that
 * `user:` colon is followed by a raw `?` or `#` and a later `@`
 * (`u:pa?ss@host`), there is no telling where the password ends, so only the
 * scheme is kept.
 */
const stripUrl = (url: string): string => {
    const scheme = url.indexOf("://") + 3;
    const afterScheme = url.slice(scheme);
    const beforeQuery = afterScheme.split(/[?#]/, 1)[0] as string;
    const at = beforeQuery.lastIndexOf("@");
    const colon = beforeQuery.indexOf(":");
    const firstSlash = beforeQuery.indexOf("/");
    const isPort = colon !== -1 && /^\d+$/.test(beforeQuery.slice(colon + 1, firstSlash === -1 ? undefined : firstSlash));
    const looksLikeUserinfo = colon !== -1 && !isPort && (firstSlash === -1 || colon < firstSlash);

    if (at === -1 && looksLikeUserinfo && afterScheme.includes("@", beforeQuery.length)) {
        return url.slice(0, scheme);
    }

    const hasUserinfo = at !== -1 && (firstSlash === -1 || at < firstSlash || (colon !== -1 && colon < at && !isPort));

    return `${url.slice(0, scheme)}${hasUserinfo ? beforeQuery.slice(at + 1) : beforeQuery}`;
};

const URL_IN_TEXT = /\b[a-z][\d+.a-z-]{1,15}:\/\/[^\s"'<>()[\]{}]+/gi;

/** A PEM private key, header through footer (or to the end of the text when the footer was cut off). */
const PEM_PRIVATE_KEY = /-----BEGIN ([A-Z ]{0,32}PRIVATE KEY)-----[\s\S]*?(?:-----END [A-Z ]{0,32}PRIVATE KEY-----|$)/g;

/** Tokens recognisable by shape alone: an auth scheme and its credential, a JWT, an AWS access-key id. */
const TOKEN_SHAPES = /\b(Basic|Bearer|Digest)\s+[\w+/=.~-]{4,}|\beyJ[\w-]{2,}\.[\w-]{2,}\.[\w-]*|\bAKIA[\dA-Z]{16}\b/g;

/** CLI credential flags: curl's `-u <user>:<password>`, `--password <value>`. */
const CLI_CREDENTIAL = /(\s|^)(-u|--user|--password|--pass|--token|--api-key)(\s+|=)[^\s"']+/g; // secret-scanner:allow -- the pattern that masks CLI credentials, not a secret

/** A `name` + separator (`=`, `:`, with optional — possibly escaped — quotes around the name). The value is read separately, only when the name is a credential. */
const ASSIGNMENT_NAME = /(?<![\w.-])(\\?["']?)([A-Za-z_][\w.-]{0,63})\1[ \t]{0,4}([:=])[ \t]{0,4}/g;

/**
 * The value after a credential's separator: an auth scheme and its token
 * (`Authorization: Bearer …` must lose both words), an escaped-quoted,
 * quoted (closing quote optional) or bare run.
 */
const ASSIGNMENT_VALUE = /(?:basic|bearer|digest|token)\s+[^\s"&'),;\]}]+|\\"(?:[^"\\\n]|\\[^"])*(?:\\")?|"[^\n"]*"?|'[^\n']*'?|[^\s"&'),;\]}]+/iy;

/**
 * After `name: value` — prose, a YAML-ish line — an unquoted credential runs to
 * the end of its clause, so `password: correct horse battery` loses every word:
 * up to a newline, `,` or `;`, a closing bracket, or the next `name:` / `name=`.
 */
const CLAUSE_TAIL = /(?:[ \t]+(?![A-Za-z_][\w.-]{0,63}[:=])[^\s,;)\]}]+)*/y;

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

        const raw = value[0];
        const quote = raw.startsWith('\\"') ? '\\"' : raw.startsWith('"') || raw.startsWith("'") ? (raw[0] as string) : "";
        let valueEnd = valueStart + raw.length;

        if (quote === "" && match[3] === ":") {
            CLAUSE_TAIL.lastIndex = valueEnd;
            valueEnd += CLAUSE_TAIL.exec(text)?.[0].length ?? 0;
        }

        output += `${text.slice(cursor, valueStart)}${quote}${REDACTED}${raw.length > quote.length && raw.endsWith(quote) ? quote : ""}`;
        cursor = valueEnd;
        ASSIGNMENT_NAME.lastIndex = cursor;
    }

    return output + text.slice(cursor);
};

/** Cheap pre-check: a string with none of these cannot hold anything the patterns mask. */
const MAY_HOLD_CREDENTIAL = /[:=@]|basic|bearer|digest|eyJ|AKIA|-u\b|--/i;

interface Budget {
    remaining: number;
}

const maskString = (value: string, budget: Budget): string => {
    if (budget.remaining <= 0) {
        return BUDGET_MARKER;
    }

    const capped = value.length > MAX_REDACTED_STRING_LENGTH ? `${value.slice(0, MAX_REDACTED_STRING_LENGTH)}…[truncated]` : value;

    budget.remaining -= capped.length;

    if (!MAY_HOLD_CREDENTIAL.test(capped)) {
        return capped;
    }

    return maskAssignments(
        capped
            .replaceAll(PEM_PRIVATE_KEY, `-----BEGIN $1-----${REDACTED}`)
            .replaceAll(URL_IN_TEXT, stripUrl)
            .replaceAll(TOKEN_SHAPES, (_match, scheme: string | undefined) => (scheme === undefined ? REDACTED : `${scheme} ${REDACTED}`))
            .replaceAll(CLI_CREDENTIAL, `$1$2$3${REDACTED}`),
    );
};

/** Built-ins whose own enumerable properties are not what they carry, and which have no `toJSON` to say what they do. */
const isOpaqueObject = (value: object): boolean =>
    value instanceof Error ||
    value instanceof RegExp ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof WeakMap ||
    value instanceof WeakSet ||
    value instanceof Promise ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value);

const NO_JSON = Symbol("no-json");

/**
 * What `JSON.stringify` would serialize `value` as, when it has a `toJSON` —
 * a `URL` becomes its href string, a `Date` its ISO string, a custom class
 * whatever it returns — so that result is what gets masked. Returning the
 * object untouched let a `URL`'s userinfo and query, or a class's
 * `toJSON(): { password }`, reach the log when the caller stringified it.
 * A `toJSON` that throws or returns the object itself yields {@link NO_JSON},
 * and the object is walked by its own properties instead.
 */
const jsonForm = (value: object): unknown => {
    const { toJSON } = value as { toJSON?: unknown };

    if (typeof toJSON !== "function") {
        return NO_JSON;
    }

    try {
        const json = (toJSON as () => unknown).call(value);

        return json === value ? NO_JSON : json;
    } catch {
        return NO_JSON;
    }
};

const MAX_DEPTH = 32;

const walk = (value: unknown, seen: WeakSet<object>, depth: number, maskStrings: boolean, budget: Budget): unknown => {
    if (typeof value === "string") {
        return maskStrings ? REDACTED : maskString(value, budget);
    }

    if (typeof value !== "object" || value === null || (!Array.isArray(value) && isOpaqueObject(value))) {
        return value;
    }

    if (seen.has(value) || depth >= MAX_DEPTH) {
        return REDACTED;
    }

    const json = Array.isArray(value) ? NO_JSON : jsonForm(value);

    if (json !== NO_JSON) {
        seen.add(value);

        const masked = walk(json, seen, depth + 1, maskStrings, budget);

        seen.delete(value);

        return masked;
    }

    seen.add(value);

    // Plain objects, and class instances by their own enumerable properties —
    // exactly what `JSON.stringify` would ship for them.
    const result = Array.isArray(value)
        ? value.map((item) => walk(item, seen, depth + 1, maskStrings, budget))
        : Object.fromEntries(
              Object.entries(value).map(([key, item]) => {
                  const kind = classifyKey(key);

                  if (kind === "secret" || (kind === "scalar-secret" && (typeof item !== "object" || item === null))) {
                      return [key, maskValue(item)];
                  }

                  // A measurement of credentials: numbers stay, containers are
                  // walked, and a bare string under it (or in an array under it,
                  // `accessTokens: ["…"]`) is the credential itself.
                  return [key, walk(item, seen, depth + 1, kind === "count-secret" && (typeof item === "string" || Array.isArray(item)), budget)];
              }),
          );

    seen.delete(value);

    return result;
};

/**
 * Mask credentials in `value` — by key name on objects and class instances (any
 * depth), and in strings by `name=value` / `name: value`, auth-scheme, JWT, PEM,
 * CLI-flag and URL shape (query, fragment and userinfo dropped). Every string is
 * capped at {@link MAX_REDACTED_STRING_LENGTH}, and once
 * {@link MAX_REDACTED_TOTAL_LENGTH} characters of one value have been examined,
 * later strings become a marker. Returns a copy; the input is never mutated.
 * A value with a `toJSON` is replaced by its masked `toJSON()` result, which is
 * what it would serialize as; `Error`s and collections are returned as-is.
 */
const maskCredentials = (value: unknown): unknown => walk(value, new WeakSet(), 0, false, { remaining: MAX_REDACTED_TOTAL_LENGTH });

export { classifyKey, maskCredentials, MAX_REDACTED_STRING_LENGTH, MAX_REDACTED_TOTAL_LENGTH };
