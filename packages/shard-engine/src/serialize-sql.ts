/**
 * Canonicalise a JS value into the SQL-bindable primitive the DO stores in a
 * column / `__sort_k&lt;i>__` blob. The output is always `null`, a `string`, or a
 * `number` — never a `boolean`, `bigint`, `Date`, or object — which makes it
 * both bindable and **JSON-safe** (so it survives the cross-shard RPC wire),
 * and the function is **idempotent** (`serializeSqlValue(serializeSqlValue(x))
 * === serializeSqlValue(x)`) because it is the identity on `string`/`number`/
 * `null`. Shared by the where-compiler, the rank companion writer
 * (`syncRankIndexEntry`), and `rankKeyFromDocument` so a value compares
 * byte-for-byte against its stored form regardless of which shard produced it.
 */
const serializeSqlValue = (value: unknown): unknown => {
    if (typeof value === "boolean") {
        return value ? 1 : 0;
    }

    if (value === null || typeof value === "string" || typeof value === "number") {
        return value;
    }

    if (typeof value === "bigint") {
        return value.toString();
    }

    return JSON.stringify(value);
};

// eslint-disable-next-line import/prefer-default-export -- named export keeps the re-export chain through `@lunora/do` uniform with the rest of the engine barrel.
export { serializeSqlValue };
