/**
 * Dotted paths into an object column: `"profile.address.city"` names `city` inside the `address`
 * object inside the `profile` column.
 *
 * Codegen rejects a column name that is not a plain identifier, so a dot in a field name is never part of
 * one and always means "descend". That is what makes `where: { "profile.plan": "pro" }` and
 * `patch(id, { "profile.plan": "pro" })` unambiguous.
 *
 * Lives in `shared/` because the DO store, the `.global()` store, the mask guard and the patch
 * resolver all need the same reading of a path and none depends on another. Inlined by the bundler;
 * keep it dependency-free.
 */
import { isPlainObject } from "./is-plain-object";

/**
 * How many segments a path may have, the column included. Bounds the SQL a path expands to. The TS path type
 * in `@lunora/server` (`SubPaths`) hard-codes the same limit as "three steps below the column"; keep them in sync.
 */
const MAX_JSON_PATH_DEPTH = 4;

/** Thrown for a malformed or unusable path; each caller rethrows it as its own error type. */
class FieldPathError extends Error {}

/** Does this field name address something inside a column rather than the column itself? */
const isFieldPath = (field: string): boolean => field.includes(".");

/** The column a field name starts from: the field itself, or the first segment of a path. */
const rootOfFieldPath = (field: string): string => {
    const dot = field.indexOf(".");

    return dot === -1 ? field : field.slice(0, dot);
};

/**
 * The segments of a path, validated: every segment non-empty and at most {@link MAX_JSON_PATH_DEPTH} of them.
 * @throws FieldPathError naming the path when it is malformed or too deep.
 */
const splitFieldPath = (field: string): string[] => {
    const segments = field.split(".");

    if (segments.length > MAX_JSON_PATH_DEPTH || segments.includes("")) {
        throw new FieldPathError(`field path "${field}" must have 1 to ${String(MAX_JSON_PATH_DEPTH)} non-empty segments`);
    }

    return segments;
};

/**
 * Read a path out of a document the way the SQL does: a missing key, or a step through something that is
 * not an object, reads as `undefined` (SQL NULL), never as an error.
 * @throws FieldPathError when the path itself is malformed or too deep.
 */
const readFieldPath = (document: Record<string, unknown>, field: string): unknown => {
    if (!isFieldPath(field)) {
        return document[field];
    }

    let current: unknown = document;

    for (const segment of splitFieldPath(field)) {
        if (!isPlainObject(current) || !Object.hasOwn(current, segment)) {
            return undefined;
        }

        current = current[segment];
    }

    return current;
};

/**
 * A copy of `value` with `leaf` set at `segments`, creating intermediate objects as needed. Siblings are
 * kept, so it is a partial update of one nested key, not a replacement of the object.
 * @throws FieldPathError when a step runs through something that is not an object.
 */
const setFieldPath = (value: unknown, segments: ReadonlyArray<string>, leaf: unknown, field: string): Record<string, unknown> => {
    const [head, ...rest] = segments;

    if (head === undefined) {
        throw new FieldPathError(`field path "${field}" is empty`);
    }

    if (value !== undefined && value !== null && !isPlainObject(value)) {
        throw new FieldPathError(`cannot set "${field}": "${head}" sits inside a value that is not an object`);
    }

    const base = value === undefined || value === null ? {} : value;

    return { ...base, [head]: rest.length === 0 ? leaf : setFieldPath(base[head], rest, leaf, field) };
};

/**
 * Fold the dotted keys of a patch into their columns: `{ "profile.plan": "pro" }` becomes
 * `{ profile: { ...current.profile, plan: "pro" } }`, siblings kept. A patch with no dotted key comes back
 * as the same object.
 * @throws FieldPathError when a patch sets a column and a path into it at once, when two paths overlap
 * (`a.b` and `a.b.c`: the result would depend on key order), or when a path runs through a non-object.
 */
const expandFieldPaths = (patch: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown> => {
    const paths = Object.keys(patch).filter((key) => isFieldPath(key));

    if (paths.length === 0) {
        return patch;
    }

    for (const path of paths) {
        const overlapping = paths.find((other) => other !== path && other.startsWith(`${path}.`));

        if (overlapping !== undefined) {
            throw new FieldPathError(`patch sets both "${path}" and "${overlapping}", which overlap; set one or the other`);
        }
    }

    const expanded: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(patch)) {
        if (!isFieldPath(key)) {
            expanded[key] = value;
        }
    }

    for (const path of paths) {
        const [root = "", ...rest] = splitFieldPath(path);

        if (Object.hasOwn(patch, root)) {
            throw new FieldPathError(`patch sets both "${root}" and "${path}"; set one or the other`);
        }

        expanded[root] = setFieldPath(Object.hasOwn(expanded, root) ? expanded[root] : current[root], rest, patch[path], path);
    }

    return expanded;
};

/** The JSON types a range (`gt`/`gte`/`lt`/`lte`) over a path can be bracketed to. */
type RangeOperandType = "boolean" | "number" | "string";

/**
 * The JSON type a range over a path is bracketed to, from its operand, or `undefined` for an operand that is none of
 * them (a Date, a bigint, an object): it has no leaf to match. Every store, SQL or in-memory, reads the rule here so
 * they cannot drift.
 */
const rangeOperandType = (operand: unknown): RangeOperandType | undefined => {
    const type = typeof operand;

    return type === "number" || type === "string" || type === "boolean" ? type : undefined;
};

/** SQLite's `json_type` names of each {@link RangeOperandType}: a boolean is `true` or `false`, a number `integer` or `real`. */
const SQLITE_JSON_TYPE_NAMES: Record<RangeOperandType, string> = { boolean: "'true', 'false'", number: "'integer', 'real'", string: "'text'" };

export type { RangeOperandType };
export { expandFieldPaths, FieldPathError, isFieldPath, rangeOperandType, readFieldPath, rootOfFieldPath, SQLITE_JSON_TYPE_NAMES, splitFieldPath };
