/**
 * The reserved data-migration id that re-projects one table's `v.bigint()` /
 * `v.bytes()` columns out of the pre-projection storage format.
 *
 * It lives in `shared/` because both ends of the command need it and neither
 * side can import the other: `@lunora/cli` builds the request and derives the
 * target table from the id, and `@lunora/shard-engine` recognises it inside the
 * Durable Object. The CLI depends on neither the engine nor `@lunora/do`, so
 * without this the prefix would be spelled twice and a typo in either half
 * would surface as `MIGRATION_NOT_FOUND` with nothing pointing at the cause.
 *
 * The `__` prefix keeps it disjoint from a user's own `defineMigration` ids.
 */
const REPROJECTION_MIGRATION_PREFIX = "__lunora_reproject__";

/** The reserved `lunora migrate up …` id that re-projects `table`. */
const reprojectionMigrationId = (table: string): string => `${REPROJECTION_MIGRATION_PREFIX}${table}`;

/** The table a reserved re-projection id targets, or `undefined` when `id` is not one. */
const reprojectionMigrationTable = (id: string): string | undefined => {
    if (!id.startsWith(REPROJECTION_MIGRATION_PREFIX)) {
        return undefined;
    }

    const table = id.slice(REPROJECTION_MIGRATION_PREFIX.length);

    return table === "" ? undefined : table;
};

export { REPROJECTION_MIGRATION_PREFIX, reprojectionMigrationId, reprojectionMigrationTable };
