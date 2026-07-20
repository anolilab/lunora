/**
 * Shared, bundler-inlined helpers for the structured `fields` a
 * `ctx.log.<level>(message, fields)` / `ctx.log.with(fields)` call carries.
 *
 * Inlined (like {@link file://./otlp.ts}) so `@lunora/do`, `@lunora/runtime`,
 * `@lunora/config`, and `@lunora/studio` — which sit on different tiers with no
 * acceptable runtime dependency edge between them — share ONE implementation of
 * field rendering/normalization instead of the byte-identical copies they would
 * otherwise hand-mirror. Keep this genuinely zero-dependency (only built-ins) so
 * inlining into each `dist` stays sound.
 */

/** Structured, filterable key/value fields attached to a `ctx.log` line. */
export type LogFields = Record<string, unknown>;

/**
 * Serialize one field value to a string: strings pass through verbatim;
 * everything else is JSON-encoded, with a `String()` fallback so a value that
 * `JSON.stringify` rejects — a `bigint`, a circular object, a function — still
 * yields a string instead of throwing.
 */
export const stringifyFieldValue = (value: unknown): string => {
    if (typeof value === "string") {
        return value;
    }

    try {
        // `JSON.stringify` returns `undefined` for a function/symbol and throws
        // on a bigint / circular reference — cover both.
        return (JSON.stringify(value) as string | undefined) ?? String(value);
    } catch {
        return String(value);
    }
};

/**
 * Coerce a field value to a JSON-safe, OTLP-`AnyValue`-encodable primitive:
 * booleans / numbers / strings pass through (a non-finite number is left for the
 * OTLP encoder to stringify); everything else is {@link stringifyFieldValue}'d.
 * This is what makes a normalized fields bag safe to `JSON.stringify` wholesale.
 */
export const coerceFieldValue = (value: unknown): boolean | number | string =>
    typeof value === "boolean" || typeof value === "number" || typeof value === "string" ? value : stringifyFieldValue(value);

/**
 * Normalize a (possibly merged) fields bag into the canonical shape every log
 * surface stores and ships: a **fresh** object (so a caller mutating the logged
 * object afterwards can't alter a buffered/queued copy), every value coerced to
 * a JSON-safe primitive (so the in-memory buffer's `getLogs` `JSON.stringify`
 * can never throw on a `bigint`/circular value), or `undefined` for an
 * absent/empty bag (so an empty `{}` doesn't ride every destination). Bound
 * `.with(...)` fields are merged under the per-call fields (per-call wins).
 */
export const normalizeLogFields = (perCall: LogFields | undefined, bound?: LogFields): LogFields | undefined => {
    if (perCall === undefined && bound === undefined) {
        return undefined;
    }

    const merged: LogFields = {};

    if (bound !== undefined) {
        for (const [key, value] of Object.entries(bound)) {
            merged[key] = coerceFieldValue(value);
        }
    }

    if (perCall !== undefined) {
        for (const [key, value] of Object.entries(perCall)) {
            merged[key] = coerceFieldValue(value);
        }
    }

    return Object.keys(merged).length === 0 ? undefined : merged;
};

/**
 * Render a fields bag as compact, space-joined `key=value` pairs for a terminal
 * or log-row display, or `""` when there are none / the value isn't a plain
 * object. Used by the dev-terminal formatter (`@lunora/config`) and the Studio
 * Logs panel (`@lunora/studio`).
 */
export const formatLogFields = (fields: unknown): string => {
    if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
        return "";
    }

    return Object.entries(fields)
        .map(([key, value]) => `${key}=${stringifyFieldValue(value)}`)
        .join(" ");
};
