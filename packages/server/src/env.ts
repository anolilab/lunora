import type { Infer, Validator } from "@lunora/values";
import { optionalInner } from "@lunora/values";

/**
 * Typed, lazily-validated env accessor — the Lunora answer to void's
 * `defineEnv`. Validates `env` per key against a map of `v.*` validators, masks
 * secret values out of any error it throws, and infers the output type from the
 * validators (reusing `@lunora/values`' `Infer`).
 *
 * Why this lives in `@lunora/server`: it is app-facing, alongside
 * `defineSchema`/`query`/`mutation`/`action`. Workers receive their secrets on
 * the `env` argument of `fetch`/`scheduled` and on `ctx.env` in actions, so a
 * handler can do `const { STRIPE_KEY } = config(env)` at the top and get a typed,
 * validated, coercion-aware value — or a clear `LunoraEnvError` listing exactly
 * which keys are missing/invalid, with secrets redacted.
 *
 * Validation model: **lazy, per-key, cached per env identity** (a `WeakMap`),
 * matching void's model. The accessor reads `env[key]` on first access of that
 * key, validates+coerces it once, and caches the result keyed by the `env`
 * object. Keys you never touch are never validated — so an unused
 * `STRIPE_KEY` won't fail boot in a code path that doesn't need Stripe. An
 * eager `.parse(env)` is also provided for callers that want fail-fast-at-boot
 * semantics (it forces every key).
 */

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
 * A credential token recognised by its KNOWN PREFIX, matched anywhere in the
 * text (not just at value-start) and at ANY length. Unlike {@link HIGH_ENTROPY_TOKEN}
 * this has no ≥24-char floor — a known prefix is a strong signal on its own, so a
 * short `sk_…` embedded in a URL or a free-form sentence is still scrubbed. A
 * `_`/`-` separator is REQUIRED after the short Stripe-style prefixes (`sk_`,
 * `xoxb-`, …) so ordinary words containing `sk`/`pk`/`rk` (e.g. "task", "work")
 * aren't clobbered; the longer fixed prefixes (`AKIA`, `AIza`, `github_pat`,
 * `Bearer `) are distinctive enough to match directly. A leading word boundary
 * (`\b`) keeps the prefix at the start of a token.
 */
const EMBEDDED_PREFIXED_TOKEN =
    /\b(?:(?:sk|pk|rk|ghp|gho|ghs|ghr)_[\w./+-]*|github_pat_[\w./+-]*|xox[baprs]-[\w./+-]*|AKIA[\w./+-]+|AIza[\w./+-]+)|Bearer\s+[\w./+-]+/gu;

/**
 * A `scheme://user:password@host` credential — the password between `:` and `@`
 * (e.g. `postgres://user:pass@host/db`). The `:`/`@` break the token run so
 * neither the standalone nor the high-entropy heuristic catches the password,
 * and `DATABASE_URL` is not a secret-named key, so without this the password
 * leaks verbatim. We redact only the password segment, keeping scheme/user/host
 * for diagnostics.
 */
const URL_CREDENTIAL = /([a-zA-Z][\w+.-]*:\/\/[^\s:/@]+):[^\s:/@]+@/gu;

/** The fixed placeholder substituted for any redacted secret. */
const REDACTED = "[redacted]";

/**
 * Keys whose **value** is a secret. Mirrors `@lunora/config`'s `.dev.vars`
 * scaffolder regex (`packages/config/src/scaffold-dev-variables.ts`, `SECRET_KEY`)
 * so the runtime validator and the scaffolder agree on what "looks secret". Kept
 * as a small local copy rather than importing `@lunora/config` — `@lunora/server`
 * is the app runtime and must not take a build/CLI-layer dependency on the config
 * package. If you change this, change it there too.
 *
 * Anchored at the end of the key (`…SECRET`, `…_TOKEN`) so `STRIPE_SECRET_KEY`
 * and `API_TOKEN` match while an innocuous `SECRETARY` does not.
 */
const SECRET_KEY = /(?:KEY|PASSWORD|SECRET|TOKEN)$/u;

/** Whether a value (already a string) looks like a credential by prefix or entropy. */
const looksLikeSecretValue = (value: string): boolean => {
    if (SECRET_VALUE_PREFIXES.some((prefix) => prefix.test(value))) {
        return true;
    }

    // A standalone long token (the whole trimmed value is one high-entropy run).
    const trimmed = value.trim();

    return trimmed.length >= 24 && STANDALONE_TOKEN.test(trimmed);
};

/** Matches a quoted (`"…"` / `'…'`) value; the inner contents are masked when credential-like. */
const QUOTED_VALUE = /(["'])(?<inner>(?:\\.|(?!\1).)*)\1/gu;

/** Matches a `KEY=value` / `KEY: value` pair; the value is masked when the key is secret-named. */
const KEYED_VALUE = /\b(?<key>[A-Za-z_]\w*)\s*[=:]\s*\S+/gu;

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

    out = out.replaceAll(QUOTED_VALUE, (match: string, ...groups: unknown[]) => {
        const named = groups.at(-1) as { inner?: string } | undefined;

        return named?.inner !== undefined && looksLikeSecretValue(named.inner) ? REDACTED : match;
    });

    // `scheme://user:pass@host` → keep `scheme://user`, redact the password.
    out = out.replaceAll(URL_CREDENTIAL, (_match, prefix: string) => `${prefix}:${REDACTED}@`);

    // Known-prefix credential tokens anywhere, any length (no entropy floor).
    out = out.replaceAll(EMBEDDED_PREFIXED_TOKEN, REDACTED);

    out = out.replaceAll(KEYED_VALUE, (match: string, ...groups: unknown[]) => {
        const named = groups.at(-1) as { key?: string } | undefined;

        return named?.key !== undefined && SECRET_KEY.test(named.key) ? `${named.key}=${REDACTED}` : match;
    });

    out = out.replaceAll(HIGH_ENTROPY_TOKEN, REDACTED);

    return out;
};

/**
 * Redact secrets from a validator error message for a specific key. Applies the
 * value-shape heuristics in {@link redactSecrets}, then — when the KEY itself is
 * secret-named — scrubs the raw value from the message unconditionally.
 *
 * Why the extra pass: the validator's message embeds the received VALUE but not
 * the KEY (e.g. `expected number, received string "p@ss w0rd!"`), so the
 * key-aware branch of `redactSecrets` never fires on it. Without this, a secret
 * that is short or contains punctuation — matching neither a known prefix nor
 * the ≥24-char high-entropy run — would leak verbatim into the thrown message.
 * Here the key is in scope, so a secret-named key masks its value directly.
 */
const redactValueForKey = (message: string, key: string, raw: unknown): string => {
    const masked = redactSecrets(message);

    if (typeof raw === "string" && raw !== "" && SECRET_KEY.test(key)) {
        return masked.replaceAll(raw, REDACTED);
    }

    return masked;
};

/** One key's validation failure, secrets already redacted out of `message`. */
interface EnvKeyFailure {
    /** The env key that failed. */
    key: string;
    /** Redacted human-readable reason. */
    message: string;
}

/**
 * Thrown when one or more env keys are missing or fail validation. Carries the
 * structured list of `failures` (each with the offending `key`) so callers can
 * react programmatically; `message` is the joined, secret-redacted summary.
 *
 * Named export only (no default) per the repo export convention.
 */
class LunoraEnvError extends Error {
    public override readonly name = "LunoraEnvError";

    public readonly failures: ReadonlyArray<EnvKeyFailure>;

    public constructor(failures: ReadonlyArray<EnvKeyFailure>) {
        const summary = failures.map((failure) => `  - ${failure.key}: ${failure.message}`).join("\n");

        super(`Invalid environment (${String(failures.length)} key(s)):\n${summary}`);
        this.failures = failures;
    }
}

/** A record of `v.*` validators describing the expected env shape. */
type EnvShape = Record<string, Validator>;

/**
 * The typed output of {@link defineEnv}. Optional validators (`v.optional(...)`)
 * become optional keys; everything else is required. Mirrors how `InferArgs`
 * derives an args object from a validator map.
 */
type InferEnv<S extends EnvShape> = {
    [K in keyof S as undefined extends Infer<S[K]> ? K : never]?: Infer<S[K]>;
} & { [K in keyof S as undefined extends Infer<S[K]> ? never : K]: Infer<S[K]> };

/**
 * The accessor returned by {@link defineEnv}. A typed view over an `env` object
 * plus a `.parse(env)` escape hatch that validates every key eagerly.
 *
 * Call the accessor with the worker's `env` to get the typed, lazily-validated
 * proxy: `const config = defineEnv({ … }); const { PORT } = config(env);`.
 */
interface EnvAccessor<S extends EnvShape> {
    /** Validate every key eagerly and return the typed, plain (non-proxy) object. Use for fail-fast-at-boot. */
    parse: (env: unknown) => InferEnv<S>;
    /** Lazily-validated, per-key-cached typed view over `env`. Keys are validated on first access. */
    (env: unknown): InferEnv<S>;
}

/** Recognised truthy/falsy string spellings for `v.boolean()` coercion. */
const TRUE_VALUES = new Set(["1", "on", "true", "yes"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

/** A clean signed integer literal — the only string shape coerced to `bigint`. */
const INTEGER_LITERAL = /^-?\d+$/u;

/** Resolve a validator's effective kind, unwrapping a leading `v.optional(...)`. */
const unwrapKind = (validator: Validator): string => {
    if (validator.kind !== "optional") {
        return validator.kind;
    }

    // Read the wrapped child through `@lunora/values`' own accessor rather than
    // reaching into the validator's internal `_meta` here — that internal layout
    // is owned by the values package.
    const inner = optionalInner(validator);

    return inner ? unwrapKind(inner) : validator.kind;
};

/**
 * Coerce a raw env value toward what a validator expects. Env vars arrive as
 * strings (Workers `env`, `process.env`, `.dev.vars`), so a `v.number()` must
 * accept `"8080"` and a `v.boolean()` must accept `"true"`. Coercion is minimal
 * and explicit: it only fires when the raw value is a `string` and the validator
 * `kind` is a primitive that env-strings commonly encode. Everything else is
 * passed through untouched (objects, already-correct types, `v.string()`, …).
 *
 * Unwraps a leading `optional` so `v.optional(v.number())` still coerces.
 */
const coerce = (validator: Validator, raw: unknown): unknown => {
    if (typeof raw !== "string") {
        return raw;
    }

    switch (unwrapKind(validator)) {
        case "bigint": {
            // Only coerce a clean integer literal; let a malformed value fail validation.
            return INTEGER_LITERAL.test(raw.trim()) ? BigInt(raw.trim()) : raw;
        }
        case "boolean": {
            const lowered = raw.trim().toLowerCase();

            if (TRUE_VALUES.has(lowered)) {
                return true;
            }

            if (FALSE_VALUES.has(lowered)) {
                return false;
            }

            return raw;
        }
        case "number": {
            const trimmed = raw.trim();

            if (trimmed === "") {
                return raw;
            }

            const parsed = Number(trimmed);

            // Leave NaN to the validator (it rejects non-finite numbers) so the
            // error names the key rather than silently passing a bad cast.
            return Number.isNaN(parsed) ? raw : parsed;
        }
        default: {
            return raw;
        }
    }
};

/**
 * Validate one key's value and either return the parsed result or push a
 * redacted {@link EnvKeyFailure}. Shared by the lazy accessor and eager parse.
 */
const validateKey = (
    key: string,
    validator: Validator,
    env: Record<string, unknown>,
    failures: EnvKeyFailure[],
): { ok: false } | { ok: true; value: unknown } => {
    const raw = env[key];

    if (raw === undefined && validator.kind === "optional") {
        return { ok: true, value: undefined };
    }

    const result = validator.safeParse(coerce(validator, raw));

    if (result.ok) {
        return { ok: true, value: result.value };
    }

    failures.push({ key, message: redactValueForKey(result.error.message, key, raw) });

    return { ok: false };
};

/** Guard that `env` is a non-null object, throwing a redacted error otherwise. */
const requireEnvObject = (env: unknown): Record<string, unknown> => {
    if (typeof env !== "object" || env === null) {
        throw new LunoraEnvError([{ key: "<env>", message: `expected an object, received ${env === null ? "null" : typeof env}` }]);
    }

    return env as Record<string, unknown>;
};

/**
 * Define a typed, validated accessor over a Worker's `env`. Pass a record of
 * `v.*` validators; receive an accessor that validates lazily per key (cached
 * per `env` identity) and infers its output type from the validators.
 *
 * ```ts
 * import { defineEnv, v } from "@lunora/server";
 *
 * const config = defineEnv({
 *     STRIPE_KEY: v.string(),
 *     PORT: v.optional(v.number()),
 * });
 *
 * export default {
 *     fetch(request, env) {
 *         const { STRIPE_KEY, PORT } = config(env); // STRIPE_KEY: string, PORT?: number
 *         // …
 *     },
 * };
 * ```
 *
 * Throws {@link LunoraEnvError} (secrets redacted) when a key is missing or
 * invalid — lazily on first access of that key, or eagerly via `config.parse(env)`.
 */
const defineEnv = <S extends EnvShape>(shape: S): EnvAccessor<S> => {
    const keys = Object.keys(shape);
    // Per-env identity cache of already-validated key values, so repeated reads
    // of the same `env` don't re-parse and unused keys are never validated.
    const cache = new WeakMap<object, Map<string, unknown>>();

    const accessor = ((env: unknown): InferEnv<S> => {
        const source = requireEnvObject(env);
        let resolved = cache.get(source);

        if (resolved === undefined) {
            resolved = new Map<string, unknown>();
            cache.set(source, resolved);
        }

        const cached = resolved;

        const read = (property: string): unknown => {
            if (cached.has(property)) {
                return cached.get(property);
            }

            const failures: EnvKeyFailure[] = [];
            const outcome = validateKey(property, shape[property] as Validator, source, failures);

            if (!outcome.ok) {
                throw new LunoraEnvError(failures);
            }

            cached.set(property, outcome.value);

            return outcome.value;
        };

        return new Proxy({} as InferEnv<S>, {
            get(_target, property: string | symbol): unknown {
                if (typeof property !== "string" || !(property in shape)) {
                    return undefined;
                }

                return read(property);
            },
            getOwnPropertyDescriptor(_target, property: string | symbol): PropertyDescriptor | undefined {
                if (typeof property === "string" && property in shape) {
                    return { configurable: true, enumerable: true, value: read(property), writable: false };
                }

                return undefined;
            },
            has(_target, property: string | symbol): boolean {
                return typeof property === "string" && property in shape;
            },
            ownKeys(): ArrayLike<string | symbol> {
                return keys;
            },
        });
    }) as EnvAccessor<S>;

    accessor.parse = (env: unknown): InferEnv<S> => {
        const source = requireEnvObject(env);
        const failures: EnvKeyFailure[] = [];
        const out: Record<string, unknown> = {};

        for (const key of keys) {
            const outcome = validateKey(key, shape[key] as Validator, source, failures);

            if (outcome.ok && outcome.value !== undefined) {
                out[key] = outcome.value;
            }
        }

        if (failures.length > 0) {
            throw new LunoraEnvError(failures);
        }

        return out as InferEnv<S>;
    };

    return accessor;
};

export type { EnvAccessor, EnvKeyFailure, EnvShape, InferEnv };
export { defineEnv, LunoraEnvError, redactSecrets };
