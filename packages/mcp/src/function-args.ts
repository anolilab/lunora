import { LunoraError } from "@lunora/errors";

import { fromBase64 } from "../../../shared/base64";

/** A JSON Schema node, as codegen emits it. Read structurally; only the keywords below are interpreted. */
type Schema = Record<string, unknown>;

const isSchema = (value: unknown): value is Schema => typeof value === "object" && value !== null && !Array.isArray(value);

const INT64_DECIMAL = /^-?\d+$/;

/**
 * The typed value for one JSON string, when its schema names a carrier that needs
 * decoding. Anything else is returned as sent.
 */
const decodeString = (schema: Schema, value: string, path: string): unknown => {
    const { contentEncoding, format } = schema;

    if (format === "int64") {
        if (!INT64_DECIMAL.test(value)) {
            throw new LunoraError("BAD_REQUEST", `"${path}" must be a decimal integer string`);
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

const coerce = (schema: Schema, value: unknown, path: string): unknown => {
    const { items, properties } = schema;

    if (typeof value === "string") {
        return decodeString(schema, value, path);
    }

    if (Array.isArray(value) && isSchema(items)) {
        return value.map((item: unknown, index) => coerce(items, item, `${path}[${index.toString()}]`));
    }

    if (isSchema(value) && isSchema(properties)) {
        return Object.fromEntries(
            Object.entries(value).map(([key, child]) => {
                const childSchema: unknown = Object.hasOwn(properties, key) ? properties[key] : undefined;

                return [key, isSchema(childSchema) ? coerce(childSchema, child, `${path}.${key}`) : child];
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
 * Walks `properties` and `items` only. A union (`anyOf`) is left as sent: the
 * branch cannot be chosen from the value alone, so a bigint inside one is not
 * coerced. Throws `BAD_REQUEST` for a string that does not decode.
 */
const coerceArgs = (argsSchema: Schema, args: Record<string, unknown>): Record<string, unknown> => coerce(argsSchema, args, "args") as Record<string, unknown>;

export { coerceArgs, isSchema };
export type { Schema };
