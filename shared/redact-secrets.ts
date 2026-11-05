/**
 * Best-effort masking of credentials in a free-form message: the redaction a
 * `defineEnv` error applies to what it echoes back.
 *
 * In `shared/` (bundler-inlined, zero-dependency) because two packages that may
 * not depend on each other need the identical masking: `@lunora/server`, whose
 * `LunoraEnvError` messages go through it, and `@lunora/config`, whose dev-start
 * env check prints the reason an `env.ts` could not be checked.
 */
import { isSecretKeyName } from "./secret-key";

/**
 * Known secret value prefixes — Stripe (`sk_`/`pk_`/`rk_`), GitHub
 * (`ghp_`/`gho_`/`ghs_`/`ghr_`/`github_pat_`), Slack (`xox[baprs]-`), AWS
 * (`AKIA`), Google (`AIza`), and bearer tokens. A value starting with one of
 * these is treated as a credential and masked out of error messages.
 */
const SECRET_VALUE_PREFIXES: ReadonlyArray<RegExp> = [
    /^sk_/u,
    /^pk_/u,
    /^rk_/u,
    /^ghp_/u,
    /^gho_/u,
    /^ghs_/u,
    /^ghr_/u,
    /^github_pat_/u,
    /^xox[baprs]-/u,
    /^AKIA/u,
    /^AIza/u,
    /^Bearer\s/u,
];

/** A single ≥24-char run of token characters — a long random-looking secret. */
const HIGH_ENTROPY_TOKEN = /[\w./+-]{24,}/gu;

/** The whole (trimmed) value is one unbroken run of token characters. */
const STANDALONE_TOKEN = /^[\w./+-]+$/u;

/**
 * Credential tokens recognised by their KNOWN PREFIX, matched anywhere in the
 * text (not just at value-start) and at ANY length. Split into two regexes to
 * keep each below the sonarjs/regex-complexity limit of 20.
 *
 * A `_`/`-` separator is REQUIRED after the short Stripe-style prefixes (`sk_`,
 * `xoxb-`, …) so ordinary words containing `sk`/`pk`/`rk` (e.g. "task", "work")
 * aren't clobbered; the longer fixed prefixes (`AKIA`, `AIza`, `github_pat`,
 * `Bearer `) are distinctive enough to match directly. A leading word boundary
 * (`\b`) keeps the prefix at the start of a token.
 */
/** Short Stripe/GitHub/Slack prefixes followed by `_` or `-`. */
const EMBEDDED_PREFIXED_TOKEN_SHORT = /\b(?:(?:sk|pk|rk|ghp|gho|ghs|ghr)_[\w./+-]*|github_pat_[\w./+-]*|xox[baprs]-[\w./+-]*)/gu;
/** Long fixed AWS/Google prefixes and Bearer tokens. */
const EMBEDDED_PREFIXED_TOKEN_LONG = /\b(?:AKIA|AIza)[\w./+-]+|Bearer\s+[\w./+-]+/gu;

/**
 * A `scheme://user:password@host` credential — the password between `:` and `@`
 * (e.g. the password segment of a `postgres://` connection string). The `:`/`@` break the token run so
 * neither the standalone nor the high-entropy heuristic catches the password,
 * and `DATABASE_URL` is not a secret-named key, so without this the password
 * leaks verbatim. We redact only the password segment, keeping scheme/user/host
 * for diagnostics.
 *
 * Anchored on the literal `://`, and the scheme is not matched at all.
 *
 * Matching it was the whole problem. An unbounded `[\w.+-]*` before `://` is
 * quadratic — `\b` limits which offsets are tried, but a payload of alternating
 * word/non-word characters (`.a.a.a…`) opens a boundary at every other position,
 * and at each one the run reached the end of the string before failing to find
 * `://`. This function is documented as safe to call on request bodies and thrown
 * errors, so that input is attacker-controlled: a 128KB body cost 4.8 SECONDS.
 *
 * Length-bounding the scheme fixed the cost and introduced a quieter bug — a
 * credential whose scheme exceeded the bound stopped being redacted at all,
 * failing OPEN on the one thing this function exists to prevent. That is the same
 * trap the user and password runs are deliberately left unbounded to avoid.
 *
 * Anchoring on `://` removes both. The scheme is only ever echoed back into the
 * replacement, never validated, so there is nothing to gain by matching it: the
 * engine finds candidates from a literal substring instead of scanning from every
 * word boundary. Measured on the same 128KB payload: 4.8s unbounded, 6ms bounded,
 * **0ms** here — and a 40-character scheme redacts correctly.
 *
 * The user run is `*`, not `+`: `redis://:password@host` and `amqps://:pw@broker`
 * are ordinary usernameless credential URLs, and requiring a username left their
 * passwords in the clear.
 *
 * The user/password class covers alphanumerics plus dot, percent-encoding, plus
 * and hyphen. Both runs stay unbounded on purpose — a bound either could exceed
 * would silently stop redacting a real credential.
 */
const URL_CREDENTIAL = /:\/\/([\w.%+-]*):[\w.%+-]+@/gu;

/** The fixed placeholder substituted for any redacted secret. */
const REDACTED = "[redacted]";

/** Whether a value (already a string) looks like a credential by prefix or entropy. */
const looksLikeSecretValue = (value: string): boolean => {
    if (SECRET_VALUE_PREFIXES.some((prefix) => prefix.test(value))) {
        return true;
    }

    // A standalone long token (the whole trimmed value is one high-entropy run).
    const trimmed = value.trim();

    return trimmed.length >= 24 && STANDALONE_TOKEN.test(trimmed);
};

/** Characters a quoted value never spans, as `.` in a regular expression doesn't. */
const LINE_TERMINATORS = new Set(["\n", "\r", "\u2028", "\u2029"]);

/**
 * Where the quoted value opened at `start` closes: at its first unescaped quote; without one before
 * the line ends, at its last escaped quote (its backslash read as a plain character); else `-1`.
 */
const closingQuoteIndex = (message: string, start: number): number => {
    const quote = message.charAt(start);
    let lastEscapedQuote = -1;
    let index = start + 1;

    while (index < message.length) {
        const character = message.charAt(index);

        if (character === quote) {
            return index;
        }

        if (LINE_TERMINATORS.has(character)) {
            break;
        }

        const next = message.charAt(index + 1);

        if (character === "\\" && index + 1 < message.length && !LINE_TERMINATORS.has(next)) {
            if (next === quote) {
                lastEscapedQuote = index + 1;
            }

            index += 2;
        } else {
            index += 1;
        }
    }

    return lastEscapedQuote;
};

/**
 * Replaces each quoted (`"…"` / `'…'`) value in `message` with `replace(match, inner)`, closing
 * each as {@link closingQuoteIndex} says.
 *
 * This is what `/(["'])((?:\\.|(?!\1).)*)\1/gu` matches, in one pass: that pattern could read
 * every backslash as an escape or as a character, so a quote followed by a run of backslashes
 * backtracked exponentially (40 backslashes took seconds; CodeQL js/polynomial-redos).
 */
const replaceQuotedValues = (message: string, replace: (match: string, inner: string) => string): string => {
    let out = "";
    let index = 0;

    while (index < message.length) {
        const character = message.charAt(index);
        const close = character === '"' || character === "'" ? closingQuoteIndex(message, index) : -1;

        if (close === -1) {
            out += character;
            index += 1;
        } else {
            out += replace(message.slice(index, close + 1), message.slice(index + 1, close));
            index = close + 1;
        }
    }

    return out;
};

/**
 * Matches a `KEY=value` / `KEY: value` pair; the value is masked when the key is
 * secret-named. A quoted value is taken whole, up to its closing quote, so a
 * secret with a space in it is not masked only up to the space.
 */
const KEYED_VALUE = /\b(?<key>[A-Za-z_]\w*)\s*[=:]\s*(?:"[^"\n]*"|'[^'\n]*'|\S+)/gu;

/**
 * Redact secrets from a free-form message. Masks, in order: any quoted value
 * whose contents look like a credential (so a value surfaced as `received string
 * "sk_live_…"` is masked even though the surrounding text is not a token); a
 * `scheme://user:password@host` URL credential (the password segment); any
 * known-prefix credential token wherever it appears, at any length; any value
 * following a secret-named key in `KEY=value` / `KEY: value` form; and any
 * remaining bare high-entropy ≥24-char token run anywhere in the message.
 *
 * This is BEST-EFFORT defense-in-depth, NOT a guarantee: a short, prefix-less
 * secret under a non-secret-named key (and embedded credentials in shapes not
 * enumerated here) can still slip through. Treat it as a backstop — prefer
 * structured logging that never serializes raw env/secret fields in the first
 * place over relying on post-hoc scrubbing of untrusted data.
 *
 * Exported because it is independently useful — call it before logging anything
 * derived from `env`, request bodies, or thrown errors.
 */
const redactSecrets = (message: string): string => {
    let out = message;

    out = replaceQuotedValues(out, (match, inner) => (looksLikeSecretValue(inner) ? REDACTED : match));

    // Redact only the password segment (between `:` and `@`), keeping scheme/user/host.
    out = out.replaceAll(URL_CREDENTIAL, (_match, user: string) => `://${user}:${REDACTED}@`);

    // Known-prefix credential tokens anywhere, any length (no entropy floor).
    out = out.replaceAll(EMBEDDED_PREFIXED_TOKEN_SHORT, REDACTED);
    out = out.replaceAll(EMBEDDED_PREFIXED_TOKEN_LONG, REDACTED);

    out = out.replaceAll(KEYED_VALUE, (match: string, ...groups: unknown[]) => {
        const named = groups.at(-1) as { key?: string } | undefined;

        return named?.key !== undefined && isSecretKeyName(named.key) ? `${named.key}=${REDACTED}` : match;
    });

    out = out.replaceAll(HIGH_ENTROPY_TOKEN, REDACTED);

    return out;
};

export { REDACTED, redactSecrets };
