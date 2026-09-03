import type { SqliteAdapter } from "./adapters/types";
import { deriveInsertId } from "./apply-diff";
import type { TableDiff } from "./table-diff";

// ── Helpers ──────────────────────────────────────────────────────────────

/** Escape an identifier for use in SQL (backtick-quoting; doubles embedded backticks so an identifier can't break out). */
const escapeIdentifier = (id: string): string => `\`${id.replaceAll("`", "``")}\``;

/** Build a `SET col = ?, col = ?` string for an UPDATE. */
const setClause = (keys: string[]): string => keys.map((key) => `${escapeIdentifier(key)} = ?`).join(", ");

/** Build a `(col, col, …)` string for INSERT column list. */
const colList = (keys: string[]): string => `(${keys.map((key) => escapeIdentifier(key)).join(", ")})`;

/** Build a `(?, ?, …)` string for INSERT value placeholders. */
const valueList = (count: number): string => `(${Array.from({ length: count }).fill("?").join(", ")})`;

/** A value every {@link SqliteAdapter} implementation accepts as a bound parameter. */
type BindValue = bigint | number | string | Uint8Array | null;

/**
 * Normalize a diff row value into a type every adapter's `exec`/`query` can
 * bind, so a value the underlying driver rejects never reaches it and aborts
 * the whole `applyDiff` transaction — `better-sqlite3` in particular throws
 * `TypeError: can only bind numbers, strings, bigints, buffers, and null` on
 * anything else, which previously took the ENTIRE diff's transaction down
 * with it (including unrelated rows in the same batch) rather than just the
 * one bad column.
 *
 * - `null`/`undefined` → SQL `NULL`.
 * - `number` / `bigint` / `string` → pass through unchanged.
 * - `boolean` → `1` / `0` (SQLite has no native boolean type).
 * - `Uint8Array` (incl. `Buffer`) → pass through unchanged (a supported bind type).
 * - Plain objects and arrays → `JSON.stringify`'d. The column is declared
 * `TEXT` by `LocalMirror#ensureTableSchema`'s affinity inference, so the
 * value reads back as a **string** — callers that stored an object/array
 * must `JSON.parse` it themselves.
 * - Anything else (function, symbol, …) → `String(value)`, as a last-resort
 * fallback so an exotic value type still can't abort the batch.
 */
// eslint-disable-next-line sonarjs/function-return-type -- normalizing onto the adapter's supported bind-value union IS the point; every branch returns a member of `BindValue`
const normalizeBindValue = (value: unknown): BindValue => {
    if (value === null || value === undefined) {
        // eslint-disable-next-line unicorn/no-null -- SQL NULL, not JS undefined
        return null;
    }

    if (typeof value === "number" || typeof value === "bigint" || typeof value === "string") {
        return value;
    }

    if (typeof value === "boolean") {
        return value ? 1 : 0;
    }

    if (value instanceof Uint8Array) {
        return value;
    }

    if (typeof value === "object") {
        return JSON.stringify(value);
    }

    // Function, symbol, etc. — no sane SQL representation. `String()` (not
    // template-literal interpolation, which `no-base-to-string` also flags)
    // is the explicit, intentional stringification here.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- intentional last-resort stringification of an otherwise-unbindable value; see the docblock above
    return String(value);
};

// ── Internal (no transaction) ─────────────────────────────────────────────

/**
 * Apply a single diff's statements directly (no transaction wrapping).
 * @param database SQLite adapter the statements run against.
 * @param diff The table diff whose row changes are applied.
 * @param pkColumn Primary key column used for DELETE/UPDATE WHERE clauses.
 */
const applySingleDiff = (database: SqliteAdapter, diff: TableDiff, pkColumn: string): void => {
    if (diff.changes.length === 0) {
        return;
    }

    const table = escapeIdentifier(diff.table);
    const pk = escapeIdentifier(pkColumn);

    for (const [changeIndex, change] of diff.changes.entries()) {
        switch (change.type) {
            case "delete": {
                database.exec(`DELETE FROM ${table} WHERE ${pk} = ?`, [normalizeBindValue(change.id)]);
                break;
            }
            case "insert": {
                const { data } = change;
                if (Object.keys(data).length === 0) {
                    continue;
                }

                // `RowChange`'s insert variant carries no `id` field, and
                // `subscribeToMirror` pushes an un-keyed row on purpose for any
                // result it cannot key (an aggregate, or a projection that does
                // not select the pk). Without a value the pk column takes no
                // binding, `LocalMirror` declares it `PRIMARY KEY NOT NULL`, and
                // the throw discards every well-keyed row in the same
                // transaction — the whole-batch failure `normalizeBindValue`
                // exists to stop, arriving through a different column. Worse, it
                // is permanent: `subscribeToMirror` advances `known` only after a
                // successful apply, so every later frame re-derives the same
                // un-keyed insert and the mirror never receives a single row.
                //
                // So derive the id the way the in-memory apply path already does
                // — same function, so the two paths agree on the key a given row
                // lands under, and a replayed diff upserts instead of
                // accumulating rows.
                const rawId = data[pkColumn];
                const row =
                    typeof rawId === "bigint" || typeof rawId === "number" || typeof rawId === "string"
                        ? data
                        : { ...data, [pkColumn]: deriveInsertId(diff, changeIndex, data) };
                const keys = Object.keys(row);

                const sql = `INSERT OR REPLACE INTO ${table} ${colList(keys)} VALUES ${valueList(keys.length)}`;
                const values = keys.map((k) => normalizeBindValue(row[k]));

                database.exec(sql, values);
                break;
            }
            case "update": {
                const { data } = change;
                const keys = Object.keys(data);
                if (keys.length === 0) {
                    continue;
                }

                const sql = `UPDATE ${table} SET ${setClause(keys)} WHERE ${pk} = ?`;
                const values = [...keys.map((k) => normalizeBindValue(data[k])), normalizeBindValue(change.id)];

                database.exec(sql, values);
                break;
            }
            default: {
                break;
            }
        }
    }
};

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Apply a {@link TableDiff} to the given SQLite database by translating
 * each row change into an INSERT, UPDATE, or DELETE statement.
 *
 * All statements are wrapped in a single transaction.
 * @param database SQLite adapter the statements run against.
 * @param diff The table diff to apply.
 * @param pkColumn Primary key column for DELETE/UPDATE (default `"id"`).
 * @experimental
 */
const applyDiffToDatabase = (database: SqliteAdapter, diff: TableDiff, pkColumn?: string): void => {
    database.transaction(() => {
        applySingleDiff(database, diff, pkColumn ?? "id");
    });
};

/**
 * Apply multiple diffs **in order** within a single transaction.
 *
 * Each diff uses `"id"` as the primary key column. For tables with a custom
 * PK, use {@link applyDiffToDatabase} per-diff and pass the PK explicitly.
 * @experimental
 */
const applyDiffsToDatabase = (database: SqliteAdapter, diffs: ReadonlyArray<TableDiff>): void => {
    if (diffs.length === 0) {
        return;
    }

    database.transaction(() => {
        for (const diff of diffs) {
            applySingleDiff(database, diff, "id");
        }
    });
};

export { applyDiffsToDatabase as applyDiffsToDb, applyDiffToDatabase as applyDiffToDb, escapeIdentifier, normalizeBindValue };
