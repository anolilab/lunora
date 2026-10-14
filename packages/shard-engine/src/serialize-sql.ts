/**
 * Canonicalise a JS value into the SQL-bindable primitive the DO stores in a
 * column / `__sort_k<i>__` blob. The output is always `null`, a `string`, or a
 * `number` — never a `boolean`, `bigint`, `Date`, or object — which makes it
 * both bindable and **JSON-safe** (so it survives the cross-shard RPC wire),
 * and the function is **idempotent** (`serializeSqlValue(serializeSqlValue(x))
 * === serializeSqlValue(x)`) because it is the identity on `string`/`number`/
 * `null`. Shared by the where-compiler, the rank companion writer
 * (`syncRankIndexEntry`), and `rankKeyFromDocument` so a value compares
 * byte-for-byte against its stored form regardless of which shard produced it.
 *
 * For `bigint` and bytes this delegates to {@link sqlComparableProjection},
 * which is the SAME function `encodeDocJson` (`do-sql.ts`) uses to decide what
 * to store at `$.field`. One function rather than two agreeing ones: the two
 * sides of every comparison are the two call sites, and a comment asking them
 * to stay in step is exactly what let a mismatch ship.
 *
 * Everything else still drifts and always has — a `Date` stores as the wire
 * codec's `["$lunora.wire$","date",5]` but binds here as
 * `"\"1970-01-01T00:00:00.005Z\""`, and `NaN`/`Infinity` likewise. Those are
 * not declarable column kinds, so no schema-typed query reaches them; a
 * `v.any()` field holding one is not queryable, the same as it was before.
 */

import { sqlComparableProjection } from "./sql-projection";

const serializeSqlValue = (value: unknown): unknown => {
    if (typeof value === "boolean") {
        return value ? 1 : 0;
    }

    if (value === null || typeof value === "string" || typeof value === "number") {
        return value;
    }

    const projected = sqlComparableProjection(value);

    // `??`, deliberately NOT `||`: `0n` projects to a zero-padded key and an
    // empty buffer to `""` — both falsy, both real projections that `||` would
    // discard in favour of the JSON fallback.
    return projected ?? JSON.stringify(value);
};

// eslint-disable-next-line import/prefer-default-export -- named export keeps the re-export chain through `@lunora/do` uniform with the rest of the engine barrel.
export { serializeSqlValue };
