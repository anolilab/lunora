/**
 * Secret-shaped string heuristics — the pure, ts-morph-free matcher extracted from
 * the `discover-secrets` feeder so any caller can classify a raw string value with
 * the *same* rule set. `@lunora/config` reuses these to scan `wrangler.jsonc`'s
 * committed `vars` (the `plaintext_secret_in_wrangler_vars` lint) without
 * duplicating — or diverging from — the codegen heuristics. Mirrors the
 * gitleaks-style rules the pre-commit `vis secrets` scan applies, narrowed to the
 * highest-signal providers so the advisor stays low-noise.
 */

/** A long, contiguous base64/hex run (length floor 40 so UUIDs/identifiers don't trip it). */
const HIGH_ENTROPY_TOKEN_RE = /[\w+/=-]{40,}/u;
/** The three character classes a high-entropy token must mix to count as key-like. */
const LOWER_RE = /[a-z]/u;
const UPPER_RE = /[A-Z]/u;
const DIGIT_RE = /\d/u;

/**
 * A long, contiguous single-case hex run (32+ chars) — a raw hex-encoded key /
 * HMAC secret. The mixed-charset {@link isHighEntropy} rule misses these because
 * an all-lowercase (or all-uppercase) hex token has no second character class.
 * The `{32,}` floor (128-bit hex and up) keeps UUIDs-without-dashes and short
 * digests out of scope while still catching 64-char (256-bit) keys.
 */
const HEX_SECRET_RE = /\b(?:[\da-f]{32,}|[\dA-F]{32,})\b/u;

/** Charset-diversity floor for the generic high-entropy rule — must mix lower, upper, and digit. */
const isHighEntropy = (value: string): boolean => {
    // A long, contiguous base64/hex run with at least three character classes is
    // far more likely a key than prose.
    const token = HIGH_ENTROPY_TOKEN_RE.exec(value)?.[0];

    if (token === undefined) {
        return false;
    }

    return LOWER_RE.test(token) && UPPER_RE.test(token) && DIGIT_RE.test(token);
};

/** A long single-case hex token — catches lowercase/uppercase-only keys the mixed-charset rule skips. */
const isHexSecret = (value: string): boolean => HEX_SECRET_RE.test(value);

/** Provider-specific secret-literal matchers, hoisted to module scope (no per-call recompilation). */
const STRIPE_LIVE_KEY_RE = /\b(?:sk|rk)_live_[\dA-Za-z]{20,}/u;
const AWS_ACCESS_KEY_RE = /\bAKIA[\dA-Z]{16}\b/u;
const GITHUB_TOKEN_RE = /\bgh[posru]_[\dA-Za-z]{36,}/u;
const OPENAI_KEY_RE = /\bsk-[\dA-Za-z]{32,}/u;
const SLACK_TOKEN_RE = /\bxox[abprs]-[\dA-Za-z-]{10,}/u;
const PRIVATE_KEY_RE = /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/u;

/**
 * Secret-shaped literal heuristics, in priority order. Each maps a `kind` label
 * (surfaced in the finding) to a matcher over a string value.
 */
const SECRET_RULES: ReadonlyArray<{ kind: string; test: (value: string) => boolean }> = [
    { kind: "stripe_live_key", test: (value) => STRIPE_LIVE_KEY_RE.test(value) },
    { kind: "aws_access_key", test: (value) => AWS_ACCESS_KEY_RE.test(value) },
    { kind: "github_token", test: (value) => GITHUB_TOKEN_RE.test(value) },
    { kind: "openai_key", test: (value) => OPENAI_KEY_RE.test(value) },
    { kind: "slack_token", test: (value) => SLACK_TOKEN_RE.test(value) },
    { kind: "private_key", test: (value) => PRIVATE_KEY_RE.test(value) },
    { kind: "high_entropy", test: isHighEntropy },
    { kind: "hex_secret", test: isHexSecret },
];

/**
 * The heuristic rules — shape alone, no vendor prefix to anchor on. A hex run or
 * a mixed-charset token is only *maybe* a secret: a hash, a fixture id, a
 * checksum, or a spec's example value has exactly the same shape.
 *
 * The vendor-prefixed kinds (`sk_live_…`, `AKIA…`, `ghp_…`, a PEM header) carry
 * their own evidence and stay unconditional — one of those in a test file is
 * still a live leak.
 */
const HEURISTIC_SECRET_KINDS: ReadonlySet<string> = new Set(["hex_secret", "high_entropy"]);

/**
 * Names that make a secret-shaped literal actually look like a secret. Used to
 * gate the heuristic kinds: "long hex string" on its own has a false-positive
 * rate near 1 (ten findings, all of them the W3C Trace
 * Context spec's example trace ids that every traceparent implementation tests
 * against).
 */
const SECRET_NAME_WORDS: ReadonlySet<string> = new Set([
    "auth",
    "bearer",
    "credential",
    "credentials",
    "hmac",
    "key",
    "keys",
    "passphrase",
    "password",
    "private",
    "secret",
    "secrets",
    "signature",
    "signing",
    "token",
]);

/** A lowercase-then-uppercase run, i.e. the seam inside `apiKey`. */
const CAMEL_BOUNDARY_RE = /([a-z\d])([A-Z])/gu;

/** Any run of non-alphanumerics — covers snake_case, kebab-case, dots and whitespace. */
const WORD_SEPARATOR_RE = /[^A-Za-z\d]+/u;

/** Split an identifier into lower-cased words across camelCase, snake_case and kebab boundaries. */
const nameWords = (name: string): string[] =>
    name
        .replaceAll(CAMEL_BOUNDARY_RE, "$1 $2")
        .split(WORD_SEPARATOR_RE)
        .filter(Boolean)
        .map((word) => word.toLowerCase());

/**
 * Whether an identifier / property name is evidence that the value it holds is
 * a secret.
 *
 * Word-wise rather than substring: a bare `/key/` also matches `monkey` and
 * `keyboard`, which widens the very gate this exists to narrow. Splitting on
 * camel/snake boundaries keeps `apiKey` and `signing_key` while dropping those.
 */
const isSecretishName = (name: string | undefined): boolean => name !== undefined && nameWords(name).some((word) => SECRET_NAME_WORDS.has(word));

/** The matching secret rule's `kind` for a string value, or `undefined` when none matches. */
const secretKindOf = (value: string): string | undefined => SECRET_RULES.find((rule) => rule.test(value))?.kind;

/** Whether a matched `kind` needs corroborating name evidence before it is reported. */
const isHeuristicSecretKind = (kind: string): boolean => HEURISTIC_SECRET_KINDS.has(kind);

/** A redacted preview of a secret value — first 4 chars plus its length, never the full value. */
const redact = (value: string): string => `${value.slice(0, 4)}…(${String(value.length)} chars)`;

export { isHeuristicSecretKind, isSecretishName, redact, SECRET_RULES, secretKindOf };
