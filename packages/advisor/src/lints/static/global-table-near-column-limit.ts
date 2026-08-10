import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * D1 runs Workerd's SQLite build, which caps a table at 100 columns where stock
 * SQLite allows 2,000. A `.global()` table is stored column-per-field, so its
 * width is `fields + 2` (the framework `id` / `_creationTime`).
 */
const MAX_GLOBAL_TABLE_COLUMNS = 100;

/** The framework columns every global table carries on top of its declared fields. */
const FRAMEWORK_COLUMNS = 2;

/**
 * How close to the ceiling counts as "near".
 *
 * At 90 there is room for ten more fields — enough that the warning arrives
 * while adding one is still a design choice, rather than on the commit that
 * breaks provisioning. Below that the number is not actionable and the lint
 * would just be noise on every wide-ish table.
 */
const WARN_AT_COLUMNS = 90;

/**
 * `global_table_near_column_limit` — flag a `.global()` table approaching D1's
 * 100-column ceiling.
 *
 * Shard-local tables are stored as a JSON document in one `__doc__` column, so
 * their field count is unbounded. A `.global()` table is not: it is provisioned
 * as a real column per declared field, and D1's SQLite refuses to create a table
 * wider than 100. The store raises a clear error at that point, but the error
 * arrives at provisioning time — on the first request after deploy — which is a
 * late and expensive place to learn a table needs splitting.
 *
 * The remediation is a design change (split the table, or collapse the tail of
 * the fields into one object field), so the warning is only useful with runway.
 * That is what {@link WARN_AT_COLUMNS} buys.
 *
 * Only `.global()` tables are checked — a `root`/`shardBy` table's fields never
 * become columns, so the ceiling does not apply to it.
 */
const globalTableNearColumnLimit: Lint = {
    categories: ["SCHEMA"],
    description: "A `.global()` table is approaching D1's 100-column ceiling, past which it cannot be created.",
    facing: "INTERNAL",
    level: "WARN",
    name: "global_table_near_column_limit",
    remediation: "Split the table, or move the tail of its fields into one object field.",
    run: (context) =>
        context.schema.tables
            .filter((table) => table.shardKind === "global" && table.fields.length + FRAMEWORK_COLUMNS >= WARN_AT_COLUMNS)
            .map((table) => {
                const columns = table.fields.length + FRAMEWORK_COLUMNS;

                return emit(globalTableNearColumnLimit, {
                    cacheKey: `global_table_near_column_limit:${table.name}`,
                    detail: `Global table "${table.name}" needs ${String(columns)} columns (${String(table.fields.length)} fields plus id and _creationTime), against D1's limit of ${String(MAX_GLOBAL_TABLE_COLUMNS)}.`,
                    metadata: { columns, limit: MAX_GLOBAL_TABLE_COLUMNS, table: table.name },
                });
            }),
    source: "static",
    title: "Global table near the column limit",
};

export default globalTableNearColumnLimit;
