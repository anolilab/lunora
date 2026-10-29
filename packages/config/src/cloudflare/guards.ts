/**
 * Type guards for values read out of a hand-edited `wrangler.jsonc`. The parsed
 * config is untrusted — TypeScript has not vouched for any of it — so every
 * validator narrows through these instead of re-spelling the checks inline.
 */

/** A non-null, non-array object: what every wrangler block (`observability`, `cache`, …) must be. */
const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A non-empty string — the shape every binding's required fields must satisfy. */
const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export { isNonEmptyString, isPlainObject };
