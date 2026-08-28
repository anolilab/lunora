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
import { LunoraError } from "@lunora/errors";
import type { ValidatorLike } from "@lunora/shard-engine";

import { effectiveKind } from "../../../shared/effective-kind";
import { decodeWire, encodeWire, needsWireEncoding, WIRE_TAG } from "../../../shared/wire-codec";

/**
 * Walk a decoded JSON column for wire tags only when one can be present.
 *
 * `decodeWire` is identity for pure JSON but still walks and rebuilds the whole
 * structure to prove it — pure overhead for the ordinary document carrying no
 * `bigint`/bytes leaf, which is the common case on the per-column path of every
 * global read. Decoding unconditionally measured ~1.3x on an object column and
 * ~1.25x on a 100-row page against a plain parse; this gate recovers about three
 * quarters of that.
 *
 * A tagged value is a JSON array whose first element is exactly {@link WIRE_TAG},
 * so a tag cannot survive `JSON.stringify` without appearing verbatim in the
 * text. Testing the raw string is therefore sound in the direction that matters:
 * a false negative is impossible, and a false positive (app data that happens to
 * contain the sentinel) merely takes the slow path and still decodes correctly.
 *
 * Takes the already-parsed value rather than parsing itself so it depends only on
 * imports: `import/exports-last` wants a non-exported helper above the exports,
 * and calling `tryJsonParse` from there would trip `no-use-before-define`.
 */
const decodeWireIfTagged = (raw: string, parsed: unknown): unknown => (raw.includes(WIRE_TAG) ? decodeWire(parsed) : parsed);

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

    // Wire-encode a composite so a nested `bigint`/bytes leaf survives. A bare
    // `JSON.stringify` threw an untyped `TypeError` on `{ n: 1n }` (surfacing as
    // an opaque 500) and silently flattened `{ b: <ArrayBuffer> }` to `{"b":{}}`
    // — data destroyed with no error at all. `encodeWire` is identity for pure
    // JSON, so an ordinary document stores byte-identically to before and
    // existing rows still read back unchanged.
    try {
        return needsWireEncoding(value) ? JSON.stringify(encodeWire(value)) : JSON.stringify(value);
    } catch (error: unknown) {
        // `encodeWire` throws a bare `TypeError` for a non-plain object and a
        // `RangeError` past its depth cap; re-thrown typed so the writer names
        // what it could not store, matching the shard twin.
        throw new LunoraError("BAD_REQUEST", `this value cannot be stored: ${error instanceof Error ? error.message : String(error)}`);
    }
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
 * Resolve the *effective* storage kind of a column validator: `v.optional(inner)`
 * unwrapped to `inner`'s kind, since encoding keys off the runtime value's JS
 * type and the validator's own `kind` of `"optional"` hides that.
 *
 * A thin alias over `shared/effective-kind`, which is where the rule lives so
 * the DO row store applies the identical one — it reads the same validators and
 * has the same failure mode, and two copies drifted the last time.
 */
export const effectiveColumnKind = (validator: ValidatorLike): string | undefined => effectiveKind(validator);

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
 * - `union`/`any`/`from`: parsed back only when the stored string is a JSON
 *   non-scalar (a scalar member round-trips through SQLite's native column type).
 *   `from` belongs to THIS group, not to `object`/`array`/`record`: an external
 *   Standard Schema can describe a string just as easily as an object, and
 *   {@link sqliteEncode} keys off the runtime JS type — so a `v.from(z.string())`
 *   column holding `"123"` is stored verbatim, and unconditional parsing would
 *   read it back as the NUMBER 123.
 *   CAVEAT: a union/any/from member is stored verbatim by {@link sqliteEncode}, so
 *   a legitimate *string* value that itself looks like JSON (`'{"a":1}'`, `'[1,2]'`)
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
        case "from":
        case "union": {
            return typeof raw === "string" && (raw.startsWith("{") || raw.startsWith("[")) ? decodeWireIfTagged(raw, tryJsonParse(raw)) : raw;
        }
        case "array":
        case "object":
        case "record": {
            return typeof raw === "string" ? decodeWireIfTagged(raw, tryJsonParse(raw)) : raw;
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
                // Copy through an owned Uint8Array rather than `raw.buffer.slice(...)`:
                // both narrow to the view's own window — a Buffer is a view over a
                // shared pool, so an unsliced `.buffer` would leak unrelated pool
                // bytes — but `.slice()` on the BUFFER preserves its species, handing
                // back a SharedArrayBuffer for a shared-memory-backed view. `v.bytes()`
                // validates `instanceof ArrayBuffer`, so that would still fail.
                return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength).slice().buffer;
            }

            return raw;
        }
        default: {
            return raw;
        }
    }
};
