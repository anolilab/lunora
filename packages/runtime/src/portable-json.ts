/**
 * Wire-form → warehouse-portable JSON mapping, shared by every egress that
 * hands Lunora documents to a THIRD PARTY (the Fivetran / Airbyte connector
 * formatters in `./connector-format`, the export-tap sinks in `./export-tap`).
 *
 * Shard admin RPCs wrap their results in `encodeWire`, so a `v.bigint()` column
 * arrives as `["$lunora.wire$","bigint","42"]` and a `v.bytes()` column as a
 * base64 tag. Those tags are correct on Lunora-native round-trips (the `/sync`
 * page and the `/export` NDJSON stream are handed straight back to a shard,
 * which decodes them via `decodeAdminArgs`) but meaningless to a warehouse —
 * left alone they land in the destination as a three-element array.
 */

import { toBase64 } from "../../../shared/base64";
import { decodeWire, isPlainObject } from "../../../shared/wire-codec";

/**
 * Map one decoded value to warehouse-portable JSON.
 *
 * `bigint` becomes its decimal STRING, always. A 64-bit column can hold values
 * on both sides of `Number.MAX_SAFE_INTEGER`, and emitting a number for the
 * small ones would make a single column's JSON type depend on its data:
 * Fivetran infers the column type from the batch and the Airbyte path emits no
 * catalog, so the destination column would flip type (or the sync error) the
 * first time a row crossed 2^53. One representation per column, lossless.
 * `ArrayBuffer` and typed arrays become a base64 string, arrays and plain
 * objects recurse, and everything else is returned unchanged (so the mapping is
 * the identity for a pure-JSON document).
 *
 * Only `bigint` and bytes need mapping because those are the only non-JSON
 * leaves a schema-validated document can hold — `v.date()` / `v.timestamp()`
 * are epoch-ms numbers and `v.url()` is a string, so no `Date`, `Map`, `Set`,
 * `URL`, or `Error` reaches here. Should a future value type produce one, it
 * would fall through unmapped (`JSON.stringify` renders a `Map` as `{}`) and
 * must be given a case below.
 */
const toPortableJson = (value: unknown): unknown => {
    if (typeof value === "bigint") {
        return value.toString();
    }

    if (value instanceof ArrayBuffer) {
        return toBase64(new Uint8Array(value));
    }

    if (ArrayBuffer.isView(value)) {
        return toBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }

    if (Array.isArray(value)) {
        return value.map((item) => toPortableJson(item));
    }

    if (isPlainObject(value)) {
        const result: Record<string, unknown> = {};

        for (const key of Object.keys(value)) {
            const mapped = toPortableJson(value[key]);

            if (key === "__proto__") {
                // A plain assignment for a literal `__proto__` field fires the
                // prototype setter instead of creating an own property (see the
                // same handling in shared/wire-codec) — install it explicitly.
                Object.defineProperty(result, key, { configurable: true, enumerable: true, value: mapped, writable: true });
            } else {
                result[key] = mapped;
            }
        }

        return result;
    }

    return value;
};

/**
 * Decode a wire-form document (as a shard admin RPC returns it) and map every
 * non-JSON leaf to a warehouse-portable value. Identity for pure-JSON docs.
 */
const toPortableDocument = (wireDocument: Record<string, unknown>): Record<string, unknown> =>
    toPortableJson(decodeWire(wireDocument)) as Record<string, unknown>;

export { toPortableDocument, toPortableJson };
