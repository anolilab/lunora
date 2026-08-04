import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a declared table that no function inserts into.
 *
 * Using `@lunora/codegen`'s write-side discovery (the analog of the read
 * discovery that feeds `filter_without_index`), this lint cross-references every
 * schema table against the set of tables some exported function writes via
 * `ctx.db.insert("<table>", …)`. A table with no such write either is dead schema
 * or is populated through a path the static analysis can't see — a migration/seed,
 * cross-region replication, the `ctx.orm.insert(...)` builder, or a trusted
 * snapshot import. Hence `INFO`/`INTERNAL`: a nudge to confirm intent, not an error.
 *
 * A table declared `.externallyManaged()` is skipped — that flag is the explicit
 * acknowledgement that its rows are written outside Lunora (an adapter/migration/
 * middleware), so `@lunora/auth`'s better-auth tables and `@lunora/ratelimit`'s
 * store never flag here.
 *
 * Only runs when the write feeder supplied evidence (`context.inserts` present);
 * a runtime caller with no insert signal flags nothing rather than every table.
 */
const tableWithoutInsert: Lint = {
    categories: ["SCHEMA"],
    description:
        'No function inserts into this table via `ctx.db.insert("<table>", …)`. It may be read-only by design (seeded by a migration, replicated, or written through a path the advisor can\'t see) — or it may be dead schema.',
    facing: "INTERNAL",
    level: "INFO",
    name: "table_without_insert",
    remediation:
        'If the table should be writable, add a mutation that calls `ctx.db.insert("<table>", …)`. If it is read-only or seeded elsewhere, this advisory can be ignored.',
    run: (context) => {
        // No write evidence supplied → nothing to assert (mirrors the query lints).
        if (context.inserts === undefined) {
            return [];
        }

        const insertedTables = new Set(context.inserts.filter((write) => write.table !== "").map((write) => write.table));

        const findings = [];

        for (const table of context.schema.tables) {
            // Skip tables that already insert, and those explicitly acknowledged
            // as written outside Lunora via `.externallyManaged()`.
            if (insertedTables.has(table.name) || table.externallyManaged === true) {
                continue;
            }

            findings.push(
                emit(tableWithoutInsert, {
                    cacheKey: `table_without_insert:${table.name}`,
                    detail: `No function calls \`ctx.db.insert("${table.name}", …)\` — table "${table.name}" has no discovered insert path.`,
                    metadata: { table: table.name },
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "Table has no insert path",
};

export default tableWithoutInsert;
