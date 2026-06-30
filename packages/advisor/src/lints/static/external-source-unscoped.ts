import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a `.source(...)` + `.shardBy(...)` table that has no `tenantBy` mapper.
 *
 * Per-shard SQLite isolation only controls *where* materialized rows land — not
 * what* the ingest query pulls. A sourced + sharded table whose `tenantBy` is
 * absent runs the same unscoped membership query on every tenant's Durable
 * Object, so each agent replicates the **entire** multitenant table into its own
 * SQLite (and then to its clients via `defineShape`). That is a cross-tenant data
 * leak, not a performance nit — so it is an `ERROR` that fails the build.
 *
 * `tenantBy(shardKey)` is the boundary: it binds this DO's shard key into the
 * query's parameters so the tenant can only ever pull its own rows.
 *
 * **Evidence supply**: reads `table.externalSource` (the codegen feeder captures
 * it from `.source({...})`; the runtime feeder derives it). A table without a
 * sourced declaration, or one not sharded, is skipped.
 */
const externalSourceUnscoped: Lint = {
    categories: ["SECURITY"],
    description:
        "A `.source(...)` table that is also `.shardBy(...)` has no `tenantBy` mapper, so every tenant's Durable Object runs the same unscoped query and replicates the whole multitenant table — a cross-tenant data leak.",
    facing: "EXTERNAL",
    level: "ERROR",
    name: "external_source_unscoped",
    remediation:
        "Add `tenantBy: (shardKey) => [shardKey]` (matching the query's bound parameters) so each shard DO pulls only its own tenant's rows. The shard key MUST bind into the source `WHERE`.",
    run: (context) => {
        const findings = [];

        for (const table of context.schema.tables) {
            if (table.externalSource === undefined || table.shardKind !== "shardBy" || table.externalSource.hasTenantBy) {
                continue;
            }

            findings.push(
                emit(externalSourceUnscoped, {
                    cacheKey: `external_source_unscoped:${table.name}`,
                    detail: `Table \`${table.name}\` is \`.source(...)\` + \`.shardBy(...)\` but declares no \`tenantBy\` — every tenant DO would pull the whole table. Add a \`tenantBy\` that binds the shard key into the query.`,
                    metadata: { table: table.name },
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "Sourced + sharded table is not tenant-scoped",
};

export default externalSourceUnscoped;
