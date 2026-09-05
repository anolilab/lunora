/**
 * Int64 read normalisation shared by the driver adapters.
 *
 * SQLite stores every integer as a signed 64-bit value, and the mirror puts
 * real int64s there: `local-mirror.ts` declares a `bigint` column `INTEGER` and
 * `diff-applier.ts` binds a `bigint` straight through. A driver that decodes
 * that column into a JS `number` loses the low bits above 2^53 — silently, and
 * for the primary key too, so `WHERE id = ?` then matches nothing.
 *
 * The drivers that can avoid it need to be asked (`safeIntegers` on
 * better-sqlite3, `useBigInt` on sql.js), and once asked they return **every**
 * integer as a `bigint`, `COUNT(*)` included. {@link narrowSafeIntegers} puts
 * that back: a value inside the safe-integer range reads as a `number` the way
 * it always did, and only a value that genuinely needs 64 bits stays a
 * `bigint`. That is also what `@sqlite.org/sqlite-wasm` does on its own, so all
 * three adapters agree on what a row looks like.
 */

/** Narrow one column value: a `bigint` inside the safe-integer range becomes a `number`. */
const narrowSafeInteger = (value: unknown): unknown =>
    typeof value === "bigint" && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;

/**
 * Narrow every `bigint` column of every row in place-free fashion: rows whose
 * columns are all ordinary values are returned as they came, so the common read
 * allocates nothing.
 */
const narrowSafeIntegers = <T>(rows: ReadonlyArray<Record<string, unknown>>): T[] =>
    rows.map((row) => {
        let narrowed: Record<string, unknown> | undefined;

        for (const [column, value] of Object.entries(row)) {
            const next = narrowSafeInteger(value);

            if (next !== value) {
                narrowed ??= { ...row };
                narrowed[column] = next;
            }
        }

        return (narrowed ?? row) as T;
    });

export { narrowSafeInteger, narrowSafeIntegers };
