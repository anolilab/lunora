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
 * The `bigint` and bytes cases MUST agree with `encodeDocJson`'s SQL-comparable
 * projection (`do-sql.ts`) — that is the form `json_extract(__doc__, '$.field')`
 * returns, and this is the other side of every comparison against it. The two
 * are asserted equal in `__tests__/ctx-db.bigint-bytes.test.ts`; drift between
 * them is invisible to types and shows up only as `filter`/`withIndex`/
 * `aggregate` silently matching nothing.
 */

import { toBase64 } from "../../../shared/base64";

const serializeSqlValue = (value: unknown): unknown => {
    if (typeof value === "boolean") {
        return value ? 1 : 0;
    }

    if (value === null || typeof value === "string" || typeof value === "number") {
        return value;
    }

    if (typeof value === "bigint") {
        // A number, not `value.toString()`: the stored projection is a JSON
        // number, so SQLite compares INTEGER-to-INTEGER (numeric ordering,
        // working `SUM`/`MIN`/`MAX`). A decimal string would compare as TEXT
        // and sort `9` after `10`.
        return Number(value);
    }

    if (value instanceof ArrayBuffer) {
        return toBase64(new Uint8Array(value));
    }

    if (ArrayBuffer.isView(value)) {
        return toBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }

    return JSON.stringify(value);
};

// eslint-disable-next-line import/prefer-default-export -- named export keeps the re-export chain through `@lunora/do` uniform with the rest of the engine barrel.
export { serializeSqlValue };
