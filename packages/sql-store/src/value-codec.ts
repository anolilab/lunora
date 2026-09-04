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
 */
import { LunoraError } from "@lunora/errors";
import type { ValidatorLike } from "@lunora/shard-engine";
import { BIGINT_KEY_DIGITS, bigintSqlKey, decodeBigintSqlKey } from "@lunora/shard-engine";

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
 *   A `bigint` member decodes too, by SHAPE: {@link sqliteEncode} keys off the
 *   runtime type, so a bigint here is stored as the same order-preserving key a
 *   declared `v.bigint()` column gets, and returning that verbatim handed the
 *   caller 40 characters of padding instead of the value it wrote. See the
 *   ambiguity this buys, and why the wire marker cannot carry it instead, below.
 *   CAVEAT: a union/any/from member is stored verbatim by {@link sqliteEncode}, so
 *   a legitimate *string* value that itself looks like JSON (`'{"a":1}'`, `'[1,2]'`)
 *   is ambiguous on read and decodes back to the parsed object/array, not the
 *   original string. The bigint test admits the same class of ambiguity, narrower
 *   but real: `decodeBigintSqlKey` accepts EXACTLY 40 characters — `"0"` or `"1"`,
 *   then 39 digits — and a stored *string* of that shape (a zero-padded account
 *   number, a numeric external id) is byte-identical on disk to a key and reads
 *   back as a `bigint`. Pinned by a test in `ctx-db.test.ts` so the trade is
 *   visible rather than rediscovered.
 *
 *   Preferred anyway, because the alternative is not "no ambiguity" but
 *   guaranteed corruption: WITHOUT the test, every bigint any code writes to an
 *   untyped column comes back as padding, on every read. The narrow false
 *   positive costs a specific 40-character digit string its type; the absent test
 *   cost every such column its value.
 *
 *   The unambiguous {@link WIRE_PREFIX} marker cannot carry this instead. It is
 *   not reached: {@link sqliteEncode} returns at its `bigint` branch first, and it
 *   takes no `kind`, so it cannot encode an untyped column differently from a
 *   declared one. It is also `serializeColumnValue`, which builds every WHERE
 *   binding — a prefixed bigint would never match a row stored as a key, and the
 *   padded key is order-preserving on purpose (indexes, range predicates, MIN/MAX
 *   all read it). Two storage forms for one runtime type breaks comparison
 *   between them. Disambiguating properly means tagging every encoded non-scalar,
 *   a breaking storage-format change, so it is documented rather than fixed.
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
            if (typeof raw !== "string") {
                return raw;
            }

            // The wire marker joins `{`/`[` as a shape this branch must decode —
            // a marked value is not raw JSON, so it would otherwise fall through
            // and be returned as its own storage string.
            if (raw.startsWith("{") || raw.startsWith("[") || raw.startsWith(WIRE_PREFIX)) {
                return decodeJsonColumn(raw, tryJsonParse);
            }

            // A bigint in an untyped column is stored as the same
            // order-preserving key a declared `v.bigint()` one gets, because
            // {@link sqliteEncode} keys off the RUNTIME type. Without this the
            // column reads back as 40 characters of padding. The shape test is
            // narrow, not exact: a stored string of the same 40-character shape
            // decodes as a bigint too — see the CAVEAT above for why that trade
            // is the right way round.
            return decodeBigintSqlKey(raw) ?? raw;
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
 * of magnitude. Exported for the provisioning pass in `ctx-db-migrations.ts`, whose
 * `WHERE LENGTH(col) <> 40` probe is how it finds a column still holding the
 * plain decimal text an earlier build wrote.
 */
export const BIGINT_KEY_LENGTH: number = BIGINT_KEY_DIGITS + 1;

export { bigintSqlKey } from "@lunora/shard-engine";
