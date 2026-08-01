/**
 * Shared value encode/decode building blocks for SQL dialects.
 *
 * The SQLite forms here are what the store core actually runs on **every**
 * engine: `serializeColumnValue`/`decodeGlobalRow` hard-code {@link sqliteEncode}
 * /{@link sqliteDecode}, so global-table storage is SQLite-shaped on D1,
 * Postgres, and MySQL alike (booleans as 1/0, JSON as TEXT, `bigint` as a decimal
 * string). The `SqlDialect.encode`/`decode` members are **not** consulted by the
 * core today — a concrete dialect that "overrides" them (PG `jsonb`/`bytea`,
 * MySQL `JSON`/`TINYINT`) would find them silently unused. Do not rely on that
 * seam without first routing the core through it.
 */
import type { ValidatorLike } from "@lunora/shard-engine";

/** Map a JS value onto its SQLite storage form — SQLite has no boolean, so true/false → 1/0. */
export const sqliteEncode = (value: unknown): unknown => {
    if (typeof value === "boolean") {
        return value ? 1 : 0;
    }

    if (value === null || typeof value === "string" || typeof value === "number") {
        return value;
    }

    if (typeof value === "bigint") {
        return value.toString();
    }

    // Bytes bind directly as a BLOB (SQLite) / BYTEA (Postgres). Must precede the
    // JSON fallback — `JSON.stringify(uint8array)` would corrupt it into `{"0":…}`
    // (silently tolerated by SQLite's loose affinity, rejected by Postgres BYTEA).
    if (value instanceof Uint8Array) {
        return value;
    }

    if (value instanceof ArrayBuffer) {
        return new Uint8Array(value);
    }

    return JSON.stringify(value);
};

/** Parse `raw` as JSON, returning `raw` unchanged when it is not valid JSON. */
export const tryJsonParse = (raw: string): unknown => {
    try {
        return JSON.parse(raw) as unknown;
    } catch {
        return raw;
    }
};

/** Decode a `bigint` column: a decimal string back into a `BigInt`, else verbatim. */
export const decodeBigint = (raw: unknown): unknown => {
    if (typeof raw !== "string") {
        return raw;
    }

    try {
        return BigInt(raw);
    } catch {
        return raw;
    }
};

/**
 * Resolve the *effective* storage kind of a column validator. Encoding keys off
 * the runtime value's JS type, so a `v.optional(inner)` column stores its
 * present value exactly as `inner` would. The validator's own `kind` is
 * `"optional"`, which hides that — unwrap to the inner validator's kind so the
 * decode reverses the real storage form. The inner validator is stashed on
 * `_meta.inner` by `@lunora/values`' `createValidator`.
 */
export const effectiveColumnKind = (validator: ValidatorLike): string | undefined => {
    if (validator.kind !== "optional") {
        return validator.kind;
    }

    const inner = (validator._meta as { inner?: ValidatorLike } | undefined)?.inner;

    return inner ? effectiveColumnKind(inner) : validator.kind;
};

/**
 * Inverse of {@link sqliteEncode}: map a SQLite storage value back onto its JS
 * form, driven by the field's effective validator `kind`:
 *
 * - `boolean`: 1/0 → true/false (SQLite has no boolean type).
 * - `bigint`: decimal string → `BigInt`.
 * - `bytes`: normalizes any driver return shape to a genuine `ArrayBuffer` — a
 *   view (`Uint8Array`/`Buffer`/…) is sliced to its own byte window, a plain
 *   `ArrayBuffer` passes through. Required because `v.bytes()` validates
 *   `value instanceof ArrayBuffer` and different backends return different BLOB
 *   shapes (workerd D1 `ArrayBuffer`, node:sqlite `Uint8Array`, pg/mysql2 `Buffer`).
 * - `object`/`array`/`record`: JSON string → parsed value.
 * - `union`/`any`: parsed back only when the stored string is a JSON non-scalar
 *   (a scalar union member round-trips through SQLite's native column type).
 *   CAVEAT: a union/any member is stored verbatim by {@link sqliteEncode}, so a
 *   legitimate *string* value that itself looks like JSON (`'{"a":1}'`, `'[1,2]'`)
 *   is ambiguous on read and decodes back to the parsed object/array, not the
 *   original string. This is inherent to sharing one TEXT column between a string
 *   and an object member; disambiguating would require a breaking storage-format
 *   change (tagging encoded non-scalars), so it is documented rather than fixed.
 * - everything else (string/number/date/timestamp/id/literal): verbatim.
 */
export const sqliteDecode = (raw: unknown, kind: string | undefined): unknown => {
    if (raw === null) {
        return raw;
    }

    switch (kind) {
        case "any":
        case "union": {
            return typeof raw === "string" && (raw.startsWith("{") || raw.startsWith("[")) ? tryJsonParse(raw) : raw;
        }
        case "array":
        case "object":
        case "record": {
            return typeof raw === "string" ? tryJsonParse(raw) : raw;
        }
        case "bigint": {
            return decodeBigint(raw);
        }
        case "boolean": {
            return raw === 0 || raw === 1 ? raw === 1 : raw;
        }
        case "bytes": {
            if (raw instanceof ArrayBuffer) {
                return raw;
            }

            if (ArrayBuffer.isView(raw)) {
                // Slice on the view's window — a Buffer is a view over a shared pool,
                // and `.buffer` without slicing would leak unrelated pool bytes.
                return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
            }

            return raw;
        }
        default: {
            return raw;
        }
    }
};
