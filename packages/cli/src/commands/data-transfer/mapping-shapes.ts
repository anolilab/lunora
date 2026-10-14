/**
 * The validation primitives both import mapping files are checked with.
 *
 * `lunora/import-convex.json` and `lunora/import-<foreign>.json` describe
 * different things and deliberately keep different shapes — the Convex export is
 * self-describing, so its mapping never needs a file name, an id column, or a
 * declared reshape. What they do share is the rule that a malformed mapping
 * throws naming the offending key rather than degrading to "no mapping": a
 * dropped mapping turns a declared rewrite into a silent pass-through, which is
 * the data corruption the file exists to prevent.
 *
 * That rule was written out twice, and the two copies phrased their errors
 * differently for the same mistake. These three checks are the whole of it.
 */
import { LunoraError } from "@lunora/errors";

/** A JSON object, excluding `null` and arrays (both of which `typeof` calls "object"). */
const isPlainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Narrow a parsed mapping file to an object, or throw naming the file. */
const assertMappingObject = (raw: unknown, where: string): Record<string, unknown> => {
    if (!isPlainObject(raw)) {
        throw new LunoraError("INTERNAL", `${where}: expected a JSON object`);
    }

    return raw;
};

/** An optional string field, or a throw naming `<where>.<key>`. */
const assertOptionalString = (raw: Record<string, unknown>, key: string, where: string): string | undefined => {
    const value = raw[key];

    if (value !== undefined && typeof value !== "string") {
        throw new LunoraError("INTERNAL", `${where}: \`${key}\` must be a string`);
    }

    return value;
};

/** An optional array-of-strings field, or a throw naming `<where>.<key>`. */
const assertOptionalStringArray = (raw: Record<string, unknown>, key: string, where: string): string[] | undefined => {
    const value = raw[key];

    if (value !== undefined && (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))) {
        throw new LunoraError("INTERNAL", `${where}: \`${key}\` must be an array of column names`);
    }

    return value as string[] | undefined;
};

export { assertMappingObject, assertOptionalString, assertOptionalStringArray, isPlainObject };
