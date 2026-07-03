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

/** The matching secret rule's `kind` for a string value, or `undefined` when none matches. */
const secretKindOf = (value: string): string | undefined => SECRET_RULES.find((rule) => rule.test(value))?.kind;

/** A redacted preview of a secret value — first 4 chars plus its length, never the full value. */
const redact = (value: string): string => `${value.slice(0, 4)}…(${String(value.length)} chars)`;

export { redact, SECRET_RULES, secretKindOf };
