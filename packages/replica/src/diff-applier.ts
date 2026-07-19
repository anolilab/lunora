import type { SqliteAdapter } from "./adapters/types";
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

    for (const change of diff.changes) {
        switch (change.type) {
            case "delete": {
                database.exec(`DELETE FROM ${table} WHERE ${pk} = ?`, [change.id]);
                break;
            }
            case "insert": {
                const { data } = change;
                const keys = Object.keys(data);
                if (keys.length === 0) {
                    continue;
                }

                const sql = `INSERT OR REPLACE INTO ${table} ${colList(keys)} VALUES ${valueList(keys.length)}`;
                const values = keys.map((k) => data[k]);

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
                const values = [...keys.map((k) => data[k]), change.id];

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

export { applyDiffsToDatabase as applyDiffsToDb, applyDiffToDatabase as applyDiffToDb, escapeIdentifier };
