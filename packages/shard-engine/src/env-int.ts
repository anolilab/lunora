/**
 * Deployment tuning knobs read off the worker `env`.
 *
 * Its own module because every tier that has a knob needs it — the relay tier's
 * fan and thresholds, the replica tier's staleness window and bootstrap cap, the
 * changelog's retention windows — and none of them should have to import another
 * tier's module to read an integer.
 *
 * The whole string has to be an integer. `Number.parseInt` stops at the first
 * character it cannot use, so it reads `"1500ms"` as `1500` and `"1.5"` as `1` —
 * quietly accepting a value the operator wrote wrong, at a number they did not
 * choose. A knob that silently reinterprets its input is worse than one that
 * ignores it, because the documented fallback is at least a value someone
 * decided on. That matters most where the effect is destructive: a retention
 * window read as `10` instead of `10000` deletes the changelog.
 */

/** A whole-string non-negative integer, with no trailing units or fraction. */
const INTEGER_PATTERN = /^\d+$/;

/** The strictly-parsed positive integer at `key`, or `undefined` when unset, malformed, or not positive. */
const readPositiveInt = (env: unknown, key: string): number | undefined => {
    const raw = (env as Record<string, unknown> | undefined)?.[key];
    let parsed = Number.NaN;

    if (typeof raw === "string" && INTEGER_PATTERN.test(raw.trim())) {
        parsed = Number(raw.trim());
    } else if (typeof raw === "number") {
        parsed = raw;
    }

    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

/** Read a positive integer env var by `key`, falling back to `fallback` when unset or invalid. */
const envPositiveInt = (env: unknown, key: string, fallback: number): number => readPositiveInt(env, key) ?? fallback;

/**
 * Read an OPTIONAL positive integer env var by `key` — `undefined` when unset or
 * invalid, with no fallback.
 *
 * For a knob whose absence is itself the meaningful state ("this feature is
 * off"), where inventing a default would turn a typo into an enabled feature
 * rather than a disabled one.
 */
const envOptionalPositiveInt = (env: unknown, key: string): number | undefined => readPositiveInt(env, key);

export { envOptionalPositiveInt, envPositiveInt };
