import { bench, describe } from "vitest";

import createSqliteExec from "../__tests__/_helpers/node-sqlite.js";

/**
 * `lookupById` locates a row by id on every get/patch/delete/replace. Ids are
 * random UUIDs, so the owning table can't be derived from the id — the lookup
 * must probe the tables.
 *
 * - **sequential** — one `SELECT ... WHERE id = ?` per table, stopping at the
 * first hit (the prior implementation). Worst case is T statements on a
 * T-table schema when the row lives in the last-probed table.
 * - **union** — one `SELECT '<t>' AS __t__, ... UNION ALL ... LIMIT 1` that
 * locates the row regardless of table count in a single round-trip (the new
 * implementation).
 *
 * Schema: 8 tables, one row each. The benched id lives in the LAST table, the
 * worst case for the sequential probe (8 statements) and where the UNION's
 * flat single-statement cost shows.
 */

const TABLE_COUNT = 8;
const tableNames = Array.from({ length: TABLE_COUNT }, (_, index) => `t${String(index)}`);
const TARGET_TABLE = tableNames.at(-1)!;
const TARGET_ID = "row-in-last-table";

const harness = createSqliteExec();

for (const tableName of tableNames) {
    harness.raw(`CREATE TABLE "${tableName}" (id TEXT PRIMARY KEY, _creationTime INTEGER, __doc__ TEXT)`);
    const id = tableName === TARGET_TABLE ? TARGET_ID : `seed-${tableName}`;

    harness.raw(`INSERT INTO "${tableName}" (id, _creationTime, __doc__) VALUES (?, ?, ?)`, id, 1, JSON.stringify({ v: 1 }));
}

const unionSql = `${tableNames
    .map((tableName) => `SELECT '${tableName}' AS __t__, id, _creationTime, __doc__ FROM "${tableName}" WHERE id = ?`)
    .join(" UNION ALL ")} LIMIT 1`;
const unionParameters = tableNames.map(() => TARGET_ID);

describe("lookupById probe — sequential per-table SELECT vs single UNION-ALL", () => {
    bench("sequential: one SELECT per table until hit (worst case = last table)", () => {
        let found: Record<string, unknown> | undefined;

        for (const tableName of tableNames) {
            const [row] = harness.raw(`SELECT id, _creationTime, __doc__ FROM "${tableName}" WHERE id = ?`, TARGET_ID);

            if (row) {
                found = row;

                break;
            }
        }

        if (!found) {
            throw new Error("bench invariant: row not located");
        }
    });

    bench("union: single UNION-ALL probe across all tables", () => {
        const [row] = harness.raw(unionSql, ...unionParameters);

        if (!row) {
            throw new Error("bench invariant: row not located");
        }
    });
});
