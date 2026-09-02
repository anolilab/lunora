/**
 * Shared value encode/decode building blocks for SQL dialects.
 *
 * The SQLite forms here are what the store core runs on **every** engine:
 * `serializeColumnValue`/`decodeGlobalRow` hard-code {@link sqliteEncode}
 * /{@link sqliteDecode}, so global-table storage is SQLite-shaped on D1,
 * Postgres, and MySQL alike (booleans as 1/0, JSON as TEXT, `bigint` as the
 * order-preserving text key {@link bigintSqlKey} builds). `SqlDialect` deliberately carries NO codec member: an engine-native
 * one there would never run, and a dialect author writing one would only learn
 * that at runtime. Adding one means routing the core through it first.
 *
 * A `bigint` column is TEXT (SQLite/Postgres) or `VARCHAR(64)` (MySQL) on every
 * engine, because no engine's native integer type holds the full range exactly
 * and `Number(value)` collapses everything past 2^53 onto the nearest double —
 * which makes `=` return *false positives* and a `.unique()` index reject two
 * genuinely different ids as duplicates. The cost of the padded key is
 * `SUM`/`AVG`/`MIN`/`MAX`: `"1000…0010"` is not a number any engine can reduce,
 * so `aggregate`/`groupBy` refuse a `v.bigint()` field on the scan path rather
 * than return the 1.5e40 that falls out of coercing padded text, and name the
 * `aggregateIndex` that answers it instead.
 */
import { LunoraError } from "@lunora/errors";
import type { ValidatorLike } from "@lunora/shard-engine";
// Same width, same sign characters, same complement as the shard plane, because
// the two MUST agree: a `.global()` table and a shard-local one are queried
// through the same `where`/`orderBy` surface, and the parity suite compares
// their answers row for row. Imported rather than restated — the reasoning for
// the scheme is written down in full at its definition in `@lunora/shard-engine`.
import { BIGINT_KEY_DIGITS, BIGINT_KEY_NEGATIVE as NEGATIVE, BIGINT_KEY_NON_NEGATIVE as NON_NEGATIVE, bigintSqlKey } from "@lunora/shard-engine";

import { effectiveKind } from "../../../shared/effective-kind";
import { decodeWire, encodeWire, needsWireEncoding, WIRE_TAG } from "../../../shared/wire-codec";

/**
 * Marks a stored column as wire-encoded. Reuses {@link WIRE_TAG} rather than
 * minting a second sentinel — as a *prefix* it cannot be confused with the tag
 * appearing *inside* a value, because `JSON.stringify` output always starts with
 * `{`, `[`, `"`, a digit, `-`, `t`, `f`, or `n`, never `$`.
 */
const WIRE_PREFIX = WIRE_TAG;

/**
 * Decode a stored JSON column, honouring the wire marker written by
 * {@link sqliteEncode}.
 *
 * Testing an explicit prefix rather than sniffing for the tag anywhere in the
 * text is what makes this unambiguous: a legacy row that merely *contains* an
 * array shaped like a wire payload is ordinary data and is returned as parsed,
 * where a content sniff would decode it and the next write would persist the
 * corruption.
 *
 * It is also the cheaper test. `decodeWire` is identity for pure JSON but still
 * walks and rebuilds the whole structure to prove it — pure overhead on the
 * per-column path of every global read, measuring ~1.3x on an object column and
 * ~1.25x on a 100-row page. A `startsWith` is O(1) against the O(n) scan a
 * content sniff needs.
 */
const decodeJsonColumn = (raw: string, parse: (text: string) => unknown): unknown =>
    raw.startsWith(WIRE_PREFIX) ? decodeWire(parse(raw.slice(WIRE_PREFIX.length))) : parse(raw);

/** A key's magnitude half: digits only, so a stored value that merely happens to be 40 characters cannot be mistaken for one. */
const BIGINT_KEY_DIGITS_RE = /^\d+$/u;

/** Nines' complement of a digit string — its own inverse, which is what makes the decode a re-application. */
const ninesComplement = (digits: string): string => Array.from(digits, (digit) => String(9 - Number(digit))).join("");

/**
 * Inverse of {@link bigintSqlKey}, or `undefined` when `raw` is not a key.
 *
 * The shape test is exact rather than heuristic: a key is always 40 characters,
 * a sign character in `{"0","1"}` followed by 39 digits. `BigInt.prototype
 * .toString()` never emits a leading zero, so no decimal string a previous build
 * stored can be mistaken for a `"0"`-prefixed key, and a `"1"`-prefixed one
 * would have to be a 40-digit value ≥ 1e39 — past what {@link bigintSqlKey} will
 * store at all. That is the whole legacy-read story: a column written before this
 * encoding still decodes, through the plain `BigInt(raw)` fallback in
 * {@link decodeBigint}.
 */
const decodeBigintSqlKey = (raw: string): bigint | undefined => {
    if (raw.length !== BIGINT_KEY_DIGITS + 1) {
        return undefined;
    }

    const sign = raw.slice(0, 1);
    const digits = raw.slice(1);

    if (!BIGINT_KEY_DIGITS_RE.test(digits)) {
        return undefined;
    }

    if (sign === NON_NEGATIVE) {
        return BigInt(digits);
    }

    return sign === NEGATIVE ? -BigInt(ninesComplement(digits)) : undefined;
};

/** Map a JS value onto its SQLite storage form — SQLite has no boolean, so true/false → 1/0. */
export const sqliteEncode = (value: unknown): unknown => {
    if (typeof value === "boolean") {
        return value ? 1 : 0;
    }

    if (value === null || typeof value === "string" || typeof value === "number") {
        return value;
    }

    if (typeof value === "bigint") {
        return bigintSqlKey(value);
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
    // — data destroyed with no error at all.
    //
    // Only a value that actually needs it is wire-encoded, and that form is
    // marked with a leading `WIRE_PREFIX` so the reader can tell it apart from
    // ordinary JSON with certainty rather than by sniffing the content. Without
    // the marker, a row already holding the array `["$lunora.wire$","bigint","42"]`
    // — legitimate app data, written before this path existed and so never passed
    // through `encodeWire`'s `"arr"` escape — decodes as `42n`, and the next
    // `patch`/`replace` persists that corruption. `encodeWire` escapes such an
    // array on the way in, so only pre-existing rows are exposed; the marker
    // closes them too.
    //
    // An ordinary document is untouched: no prefix, byte-identical to before.
    try {
        return needsWireEncoding(value) ? WIRE_PREFIX + JSON.stringify(encodeWire(value)) : JSON.stringify(value);
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

/**
 * Decode a `bigint` column: the order-preserving key {@link bigintSqlKey} writes,
 * or — for a row stored by a build that wrote plain decimal text — the decimal
 * string, else verbatim.
 */
export const decodeBigint = (raw: unknown): unknown => {
    if (typeof raw !== "string") {
        return raw;
    }

    const key = decodeBigintSqlKey(raw);

    if (key !== undefined) {
        return key;
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
 * - `object`/`array`/`record`/`geoPoint`: JSON string → parsed value. `geoPoint`
 *   belongs here because {@link sqliteEncode} keys off the runtime JS type and
 *   stores the `{ lat, lng }` object as JSON in a TEXT column; without the case
 *   it fell through to `default:` and every client read back the raw JSON text.
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
            // The wire marker joins `{`/`[` as a shape this branch must decode —
            // a marked value is not raw JSON, so it would otherwise fall through
            // and be returned as its own storage string.
            return typeof raw === "string" && (raw.startsWith("{") || raw.startsWith("[") || raw.startsWith(WIRE_PREFIX))
                ? decodeJsonColumn(raw, tryJsonParse)
                : raw;
        }
        case "array":
        case "geoPoint":
        case "object":
        case "record": {
            return typeof raw === "string" ? decodeJsonColumn(raw, tryJsonParse) : raw;
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

/**
 * Full width of a stored key: one sign character plus {@link BIGINT_KEY_DIGITS}
 * of magnitude. Exported for the provisioning pass in `ctx-db.ts`, whose
 * `WHERE LENGTH(col) <> 40` probe is how it finds a column still holding the
 * plain decimal text an earlier build wrote.
 */
export const BIGINT_KEY_LENGTH: number = BIGINT_KEY_DIGITS + 1;

export { bigintSqlKey } from "@lunora/shard-engine";
