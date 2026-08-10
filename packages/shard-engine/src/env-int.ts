/**
 * Deployment tuning knobs read off the worker `env`.
 *
 * Its own module because every tier that has a knob needs it — the relay tier's
 * fan and thresholds, the replica tier's staleness window and bootstrap cap —
 * and none of them should have to import another tier's module to read an
 * integer.
 */

/**
 * Read a positive integer env var by `key`, falling back to `fallback` when
 * unset or invalid.
 *
 * The whole string has to be an integer. `Number.parseInt` stops at the first
 * character it cannot use, so it reads `"1500ms"` as `1500` and `"1.5"` as `1`
 * — quietly accepting a value the operator wrote wrong, at a number they did
 * not choose. A knob that silently reinterprets its input is worse than one
 * that ignores it, because the documented fallback is at least a value someone
 * decided on.
 */
/** A whole-string non-negative integer, with no trailing units or fraction. */
const INTEGER_PATTERN = /^\d+$/;

const envPositiveInt = (env: unknown, key: string, fallback: number): number => {
    const raw = (env as Record<string, unknown> | undefined)?.[key];
    let parsed = Number.NaN;

    if (typeof raw === "string" && INTEGER_PATTERN.test(raw.trim())) {
        parsed = Number(raw.trim());
    } else if (typeof raw === "number") {
        parsed = raw;
    }

    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export default envPositiveInt;
