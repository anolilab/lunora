/**
 * Deployment tuning knobs read off the worker `env`.
 *
 * Its own module because every tier that has a knob needs it — the relay tier's
 * fan and thresholds, the replica tier's staleness window and bootstrap cap —
 * and none of them should have to import another tier's module to read an
 * integer.
 */

/** Read a positive integer env var by `key`, falling back to `fallback` when unset/invalid. */
const envPositiveInt = (env: unknown, key: string, fallback: number): number => {
    const raw = (env as Record<string, unknown> | undefined)?.[key];
    let parsed = Number.NaN;

    if (typeof raw === "string") {
        parsed = Number.parseInt(raw, 10);
    } else if (typeof raw === "number") {
        parsed = raw;
    }

    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export default envPositiveInt;
