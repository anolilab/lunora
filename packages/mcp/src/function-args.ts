import { LunoraError } from "@lunora/errors";

import { fromBase64 } from "../../../shared/base64";

/** A JSON Schema node, as codegen emits it. Read structurally; only the keywords below are interpreted. */
type Schema = Record<string, unknown>;

const isSchema = (value: unknown): value is Schema => typeof value === "object" && value !== null && !Array.isArray(value);

const INT64_DECIMAL = /^-?\d+$/;

/**
 * The longest decimal `bigint` the wire codec accepts, sign included. Mirrors
 * `MAX_BIGINT_DIGITS` in `@lunora/wire`'s `wire-codec.ts`: past it the value would
 * fail at serialization with an INTERNAL error instead of naming the bad argument.
 */
const MAX_BIGINT_DIGITS = 1024;

/**
 * The typed value for one JSON string, when its schema names a carrier that needs
 * decoding. Anything else is returned as sent.
 */
const decodeString = (schema: Schema, value: string, path: string): unknown => {
    const { contentEncoding, format } = schema;

    if (format === "int64") {
        if (!INT64_DECIMAL.test(value) || value.length > MAX_BIGINT_DIGITS) {
            throw new LunoraError("BAD_REQUEST", `"${path}" must be a decimal integer string of at most ${String(MAX_BIGINT_DIGITS)} digits`);
        }

        return BigInt(value);
    }

    if (contentEncoding === "base64") {
        try {
            return fromBase64(value).buffer;
        } catch {
            throw new LunoraError("BAD_REQUEST", `"${path}" must be base64`);
        }
    }

    return value;
};

/** Whether a branch's JSON Schema `type` accepts the value. */
const acceptsJsonType = (branch: Schema, value: unknown): boolean => {
    const { type } = branch;

    // A branch that names no single type (a list, or none at all) cannot be ruled out from the value.
    if (typeof type !== "string") {
        return true;
    }

    if (type === "integer" || type === "number") {
        return typeof value === "number";
    }

    if (type === "array") {
        return Array.isArray(value);
    }

    if (type === "object") {
        return isSchema(value);
    }

    return type === typeof value;
};

/**
 * A canonical base64 string: whole four-character groups, with `=` padding only at
 * the end. A decimal string whose length is a multiple of four also matches.
 */
const BASE64_CANONICAL = /^(?:[\dA-Z+/]{4})*(?:[\dA-Z+/]{2}==|[\dA-Z+/]{3}=)?$/i;

/**
 * Whether a string is in the carrier its branch names. Selection is stricter than
 * decoding on purpose: `atob` also takes unpadded base64, which would make a short
 * decimal string look like bytes.
 */
const carrierFits = (branch: Schema, value: string): boolean => {
    if (branch["format"] === "int64" && !INT64_DECIMAL.test(value)) {
        return false;
    }

    return branch["contentEncoding"] !== "base64" || BASE64_CANONICAL.test(value);
};

/** Whether every discriminator property the branch fixes with `const` matches the object's value. */
const discriminatorsFit = (properties: Schema, value: Schema): boolean =>
    Object.entries(properties).every(([key, property]) => {
        if (!isSchema(property) || !Object.hasOwn(property, "const") || !Object.hasOwn(value, key)) {
            return true;
        }

        return value[key] === property["const"];
    });

/**
 * Whether a branch can take the value: its JSON type, its `const`, the discriminators
 * of an object, and the carrier of a string all agree with it.
 */
const acceptsValue = (branch: Schema, value: unknown): boolean => {
    if (!acceptsJsonType(branch, value)) {
        return false;
    }

    if (Object.hasOwn(branch, "const") && branch["const"] !== value) {
        return false;
    }

    if (isSchema(value) && isSchema(branch["properties"]) && !discriminatorsFit(branch["properties"], value)) {
        return false;
    }

    return typeof value !== "string" || carrierFits(branch, value);
};

/**
 * The one `anyOf` branch that accepts a non-null value (see {@link acceptsValue}).
 * Zero or several fitting branches return `undefined`: the value is then sent as it
 * is, and the validator decides. A decimal string of a length divisible by four is
 * both an int64 and a base64 carrier, so a bigint-or-bytes union leaves it that way.
 */
const branchFor = (branches: unknown[], value: unknown): Schema | undefined => {
    const fitting = branches.filter((branch): branch is Schema => isSchema(branch) && acceptsValue(branch, value));

    return fitting.length === 1 ? fitting[0] : undefined;
};

/** The schema a key's value is decoded with: its named property, else the record's `additionalProperties` schema. */
const childSchemaOf = (schema: Schema, key: string): Schema | undefined => {
    const { additionalProperties, properties } = schema;
    const named: unknown = isSchema(properties) && Object.hasOwn(properties, key) ? properties[key] : additionalProperties;

    return isSchema(named) ? named : undefined;
};

const coerce = (schema: Schema, value: unknown, path: string): unknown => {
    const { anyOf, items } = schema;

    // Null carries no carrier, whatever the schema, so it is never decoded.
    if (value === null) {
        return value;
    }

    if (Array.isArray(anyOf)) {
        const branch = branchFor(anyOf, value);

        return branch === undefined ? value : coerce(branch, value, path);
    }

    if (typeof value === "string") {
        return decodeString(schema, value, path);
    }

    if (Array.isArray(value) && isSchema(items)) {
        return value.map((item: unknown, index) => coerce(items, item, `${path}[${index.toString()}]`));
    }

    if (isSchema(value)) {
        return Object.fromEntries(
            Object.entries(value).map(([key, child]) => {
                const childSchema = childSchemaOf(schema, key);

                return [key, childSchema === undefined ? child : coerce(childSchema, child, `${path}.${key}`)];
            }),
        );
    }

    return value;
};

/**
 * Turn the JSON form of a model's arguments back into the typed values the
 * validators expect. Lunora's JSON Schema describes `v.bigint()` as a decimal
 * string (`format: "int64"`) and `v.bytes()` as base64 (`contentEncoding:
 * "base64"`), because those are what JSON can carry. The RPC encoder turns a
 * real `bigint` or `ArrayBuffer` into its tagged wire form, but nothing turns the
 * string into the typed value, so a bare `"5"` would fail `v.bigint()`.
 *
 * Walks `properties`, `additionalProperties` (a record's values) and `items`. A
 * union or nullable (`anyOf`) is decoded through the one branch the value fits: by
 * JSON type, `const`, discriminator property and string carrier. A value that fits
 * several branches is sent as it is: picking one would guess, and the validator is
 * the place that decides. Throws `BAD_REQUEST` for a string that does not decode.
 */
const coerceArgs = (argsSchema: Schema, args: Record<string, unknown>): Record<string, unknown> => coerce(argsSchema, args, "args") as Record<string, unknown>;

export { coerceArgs, isSchema };
export type { Schema };
