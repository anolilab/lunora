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

/** Longest single string kept; the rest is cut. */
const MAX_REDACTED_STRING_LENGTH = 4096;

/**
 * Characters examined past {@link MAX_REDACTED_STRING_LENGTH} before the cut, so
 * a token that starts before the cap is whole when the patterns see it. More than
 * any secret shape's minimum length.
 */
const CAP_OVERSCAN = 128;

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

/** An auth scheme and its credential. */
const TOKEN_SHAPES = /\b(Basic|Bearer|Digest)\s+[\w+/=.~-]{4,}/g;

/**
 * What may sit right before a vendor token when that token is glued to other
 * text: a percent-encoded byte (`key%3Dsk_live_…`, `msg%20ghp_…`) or a
 * JSON/JS escape (`"retry\nghp_…"`). The character before such a token is a
 * letter or digit, so a plain "not after a letter or digit" guard would miss it.
 */
const ENCODED_SEPARATOR = String.raw`%[\dA-Fa-f]{2}|\\(?:[bfnrt]|u[\dA-Fa-f]{4})`;

/**
 * One secret format recognisable by its value alone. `prefix` is the regex
 * source of its literal vendor prefix; the pre-check {@link MAY_HOLD_SECRET_VALUE}
 * is built from these, so a rule can never be added without the gate admitting
 * it. `body` follows the prefix.
 */
interface SecretValueRule {
    body: string;
    name: string;
    prefix: string;
}

/**
 * Formats with a vendor prefix that ordinary text, ids and hashes never start
 * with. No rule matches on length or alphabet alone: those turned trace ids,
 * uuids and git shas into placeholders.
 */
const SECRET_VALUE_RULES: ReadonlyArray<SecretValueRule> = [
    { body: String.raw`[\dA-Za-z]{10,}`, name: "Stripe secret or restricted key", prefix: String.raw`[rs]k_(?:live|test)_` },
    { body: String.raw`[\d+/=A-Za-z]{20,}`, name: "Stripe webhook secret", prefix: "whsec_" },
    { body: String.raw`[\dA-Za-z]{30,}`, name: "GitHub classic token (personal, OAuth, user/server-to-server, refresh)", prefix: "gh[oprsu]_" },
    { body: String.raw`\w{20,}`, name: "GitHub fine-grained token", prefix: "github_pat_" },
    { body: String.raw`[\w-]{20,}`, name: "GitLab personal, pipeline-trigger and deploy tokens", prefix: "gl(?:pat|ptt|dt)-" },
    // Bot (b), user (p), workspace (a), refresh (r), legacy service (s), config (e), client (c) and cookie (d) tokens.
    { body: String.raw`[\dA-Za-z-]{10,}`, name: "Slack token", prefix: "xox[a-eprs]-" },
    { body: String.raw`\d-[\dA-Za-z-]{10,}`, name: "Slack app-level token", prefix: "xapp-" },
    { body: String.raw`[\dA-Z]{16}\b`, name: "AWS access-key id, long-lived and temporary", prefix: "(?:AKIA|ASIA)" },
    { body: String.raw`[\w-]{35}(?![\w-])`, name: "Google API key", prefix: "AIza" },
    { body: String.raw`[\w-]{24,}`, name: "Google OAuth client secret", prefix: "GOCSPX-" },
    { body: String.raw`[\w-]{20,}`, name: "Google OAuth access token", prefix: String.raw`ya29\.` },
    { body: String.raw`[\dA-Za-z]{36}\b`, name: "npm token", prefix: "npm_" },
    { body: String.raw`[\dA-Za-z]{30,}`, name: "Hugging Face token", prefix: "hf_" },
    { body: String.raw`[\dA-Fa-f]{32}\b`, name: "Shopify token", prefix: "shp(?:at|ca|pa|ss)_" },
    { body: String.raw`[\da-f]{64}\b`, name: "DigitalOcean token", prefix: "do[opr]_v1_" },
    { body: String.raw`[\w-]{20,}`, name: "OpenAI project/service/admin key, Anthropic key", prefix: "sk-(?:admin|ant|proj|svcacct)-" },
    { body: String.raw`[\dA-Za-z]{20}T3BlbkFJ[\dA-Za-z]{20}\b`, name: "OpenAI legacy key", prefix: "sk-" },
    { body: String.raw`[\w-]{22}\.[\w-]{43}(?![\w-])`, name: "SendGrid key", prefix: String.raw`SG\.` },
];

/**
 * A JWT: three base64url segments, the header starting `eyJ`. It is the one
 * shape with an unbounded run followed by something required (`.`), so it may
 * only start where a `[\w-]` run starts: inside `eyJ-eyJ-eyJ-…` every `eyJ`
 * would otherwise rescan the rest of the run and fail, which is quadratic.
 */
const JWT_SHAPE = String.raw`(?<=^|[^\w-]|${ENCODED_SEPARATOR})eyJ[\w-]{2,}\.[\w-]{2,}\.[\w-]*`;

/**
 * Every secret value shape. A vendor token may follow anything but a letter or
 * digit (`STRIPE_sk_live_…` is caught, `task_live_status` is not), or an encoded
 * separator. Every body is either fixed-length or an unbounded run that succeeds
 * as soon as it reaches its minimum, and the JWT may start only at the start of a
 * run, so a scan is linear in the input.
 */
const SECRET_VALUE_SHAPES = new RegExp(
    [...SECRET_VALUE_RULES.map(({ body, prefix }) => String.raw`(?<=^|[^\dA-Za-z]|${ENCODED_SEPARATOR})${prefix}${body}`), JWT_SHAPE].join("|"),
    "g",
);

/**
 * Cheap pre-check for {@link SECRET_VALUE_SHAPES}: one of its literal prefixes,
 * built from the same rules. Kept apart from {@link MAY_HOLD_CREDENTIAL}, so a
 * string that is only there for a `:` (a route, a URL, a timestamp) does not also
 * pay for the vendor patterns.
 */
const MAY_HOLD_SECRET_VALUE = new RegExp([...SECRET_VALUE_RULES.map(({ prefix }) => prefix), "eyJ"].join("|"));

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
const MAY_HOLD_CREDENTIAL = /[:=@]|basic|bearer|digest|-u\b|--/i;

interface Budget {
    remaining: number;
}

/** Mask every credential form in `text`. Callers bound `text`: every pattern is linear, the key/value ones are not all. */
const maskText = (text: string): string => {
    const mayHoldSecretValue = MAY_HOLD_SECRET_VALUE.test(text);

    if (!mayHoldSecretValue && !MAY_HOLD_CREDENTIAL.test(text)) {
        return text;
    }

    const masked = text
        .replaceAll(PEM_PRIVATE_KEY, `-----BEGIN $1-----${REDACTED}`)
        .replaceAll(URL_IN_TEXT, stripUrl)
        .replaceAll(TOKEN_SHAPES, `$1 ${REDACTED}`);

    return maskAssignments((mayHoldSecretValue ? masked.replaceAll(SECRET_VALUE_SHAPES, REDACTED) : masked).replaceAll(CLI_CREDENTIAL, `$1$2$3${REDACTED}`));
};

const maskString = (value: string, budget: Budget): string => {
    if (budget.remaining <= 0) {
        return BUDGET_MARKER;
    }

    // Mask a little past the cap, then cut: cutting first would leave a token that
    // straddles the cap shorter than its own minimum length, so no rule would
    // recognise the part that is kept.
    const scanned = value.slice(0, MAX_REDACTED_STRING_LENGTH + CAP_OVERSCAN);

    budget.remaining -= scanned.length;

    const masked = maskText(scanned);

    return masked.length > MAX_REDACTED_STRING_LENGTH || value.length > scanned.length ? `${masked.slice(0, MAX_REDACTED_STRING_LENGTH)}…[truncated]` : masked;
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
 * depth), and in strings by `name=value` / `name: value`, auth-scheme, vendor
 * token prefix ({@link SECRET_VALUE_RULES}: Stripe, GitHub, Slack, AWS, JWT, …), PEM,
 * CLI-flag and URL shape (query, fragment and userinfo dropped). Every string is
 * masked over its first {@link MAX_REDACTED_STRING_LENGTH} + {@link CAP_OVERSCAN} characters and then
 * cut to {@link MAX_REDACTED_STRING_LENGTH}, and once
 * {@link MAX_REDACTED_TOTAL_LENGTH} characters of one value have been examined,
 * later strings become a marker. Returns a copy; the input is never mutated.
 * A value with a `toJSON` is replaced by its masked `toJSON()` result, which is
 * what it would serialize as; `Error`s and collections are returned as-is.
 */
const maskCredentials = (value: unknown): unknown => walk(value, new WeakSet(), 0, false, { remaining: MAX_REDACTED_TOTAL_LENGTH });

export { classifyKey, maskCredentials, MAX_REDACTED_STRING_LENGTH, MAX_REDACTED_TOTAL_LENGTH, MAY_HOLD_SECRET_VALUE, SECRET_VALUE_RULES };
export type { SecretValueRule };
