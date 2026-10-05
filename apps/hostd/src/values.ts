/**
 * Small value helpers the daemon and the binary's commands share, so each has
 * exactly one definition.
 */

/** A plain object: not `null`, not an array. */
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** `{ [key]: value }`, or `{}` when `value` is absent — for spreading an optional field into an object literal. */
const optional = <K extends string, T>(key: K, value: T | undefined): Partial<Record<K, T>> =>
    (value === undefined ? {} : { [key]: value }) as Partial<Record<K, T>>;

export { isRecord, optional };
