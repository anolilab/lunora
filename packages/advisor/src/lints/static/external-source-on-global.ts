import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a table that is both `.source(...)` and `.global()`.
 *
 * The two are contradictory. `.global()` already places a table in an external
 * store (D1, or a Hyperdrive-fronted Postgres/MySQL) that Lunora owns the schema
 * for and reads through the global backend. `.source(...)` declares the table as
 * **materialized from** an external database into a shard DO's SQLite by the
 * ingest poll loop. A table cannot simultaneously live in the global tier and be
 * polled into per-shard SQLite — the ingest loop has no DO-local table to write,
 * and the global backend has no poll loop. This is a definite misconfiguration,
 * so it is an `ERROR`.
 *
 * **Evidence supply**: reads `table.externalSource` + `table.shardKind`. Skipped
 * unless both a sourced declaration and the `global` tier are present.
 */
const externalSourceOnGlobal: Lint = {
    categories: ["SCHEMA"],
    description:
        "A table is both `.source(...)` and `.global()`. A global table lives in the external/global tier; a sourced table is materialized into a shard DO's SQLite — the two are mutually exclusive.",
    facing: "INTERNAL",
    level: "ERROR",
    name: "external_source_on_global",
    remediation:
        'Drop either `.source(...)` or `.global()`. To ingest an external database into per-tenant DOs, use `.source(...)` with `.shardBy(...)`; to read it in place as a global table, use `.global({ backend: "hyperdrive" })`.',
    run: (context) =>
        context.schema.tables
            .filter((table) => table.externalSource !== undefined && table.shardKind === "global")
            .map((table) =>
                emit(externalSourceOnGlobal, {
                    cacheKey: `external_source_on_global:${table.name}`,
                    detail: `Table \`${table.name}\` is both \`.source(...)\` and \`.global()\` — contradictory. A sourced table materializes into a shard DO's SQLite; a global table lives in the external tier.`,
                    metadata: { table: table.name },
                }),
            ),
    source: "static",
    title: "Sourced table cannot also be global",
};

export default externalSourceOnGlobal;
