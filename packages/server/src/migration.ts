/**
 * Online data-migration authoring API.
 *
 * `defineMigration` declares a per-document backfill over one table: `up`
 * transforms every existing row, `down` (optional) reverses it. Unlike the D1
 * SQL schema migrations in `@cirrus/d1`, these run *inside each shard's*
 * Durable Object against live documents, in keyset batches, and are resumable —
 * the per-shard runner in `@cirrus/do` tracks progress in a reserved
 * `__cirrus_migrations` table so an interrupted run picks up where it stopped.
 *
 * The returned object carries a `__cirrusMigration` brand so codegen can
 * discover declarations through the type checker (mirroring the procedure
 * builder's `__cirrusProcedure` brand) and emit them into a `CIRRUS_MIGRATIONS`
 * registry the DO and CLI look migrations up by id.
 */

/** A document handed to a migration transform: the stored row including `_id`/`_creationTime`. */
export type MigrationDocument = Record<string, unknown>;

/**
 * Transform applied to one document. Return a new document to rewrite the row,
 * or `undefined` to leave it untouched (skipped, not counted as changed). The
 * runner always preserves the original `_id` and `_creationTime`, so the
 * returned document neither needs to nor should change row identity.
 */
export type MigrationTransform = (document: MigrationDocument) => MigrationDocument | undefined | void;

export interface MigrationDefinition {
    /** Rows fetched and rewritten per batch. Defaults to the runner's batch size when omitted. */
    readonly batchSize?: number;
    /** Optional reverse transform, applied by `migrate down`. */
    readonly down?: MigrationTransform;
    /** Stable, unique identifier — the key per-shard run-state is tracked under. */
    readonly id: string;
    /** Table whose documents this migration iterates. */
    readonly table: string;
    /** Forward transform, applied to every row by `migrate up`. */
    readonly up: MigrationTransform;
}

/** A {@link MigrationDefinition} plus the codegen discovery marker. */
export interface RegisteredMigration extends MigrationDefinition {
    readonly __cirrusMigration: true;
}

/** Declare an online data migration. See the module docs for runtime semantics. */
export const defineMigration = (definition: MigrationDefinition): RegisteredMigration => {
    if (definition.id.trim() === "") {
        throw new Error("defineMigration: `id` must be a non-empty string");
    }

    return { __cirrusMigration: true, ...definition };
};
