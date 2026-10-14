/**
 * Online data-migration authoring API.
 *
 * `defineMigration` declares a per-document backfill over one table: `up`
 * transforms every existing row, `down` (optional) reverses it. Unlike the D1
 * SQL schema migrations in `@lunora/d1`, these run *inside each shard's*
 * Durable Object against live documents, in keyset batches, and are resumable —
 * the per-shard runner in `@lunora/do` tracks progress in a reserved
 * `__lunora_migrations` table so an interrupted run picks up where it stopped.
 *
 * The returned object carries a `__lunoraMigration` brand so codegen can
 * discover declarations through the type checker (mirroring the procedure
 * builder's `__lunoraProcedure` brand) and emit them into a `LUNORA_MIGRATIONS`
 * registry the DO and CLI look migrations up by id.
 */
import { LunoraError } from "@lunora/errors";

/** A document handed to a migration transform: the stored row including `_id`/`_creationTime`. */
export type MigrationDocument = Record<string, unknown>;

/**
 * The read surface a transform reaches through its `ctx`.
 *
 * Read-only by design: the runner accounts for exactly one rewrite per row read,
 * and a transform writing directly would make that count describe something
 * other than what happened. Scoped to the shard the runner is walking.
 */
export interface MigrationReader {
    count: (table: string, where?: Record<string, unknown>) => Promise<number>;
    findFirst: (table: string, args?: Record<string, unknown>) => Promise<MigrationDocument | null>;
    findMany: (table: string, args?: Record<string, unknown>) => Promise<{ isDone: boolean; page: MigrationDocument[] }>;
    get: (id: string, expectedTable?: string) => Promise<MigrationDocument | null>;
}

/** The context handed to a transform alongside the row. */
// eslint-disable-next-line unicorn/prevent-abbreviations -- public API name, matching the `QueryCtx`/`MutationCtx`/`HttpActionCtx` family; renaming would break consumers
export interface MigrationCtx {
    db: MigrationReader;
}

/**
 * Transform applied to one document. Return a new document to rewrite the row,
 * or `undefined` to leave it untouched (skipped, not counted as changed). The
 * runner always preserves the original `_id` and `_creationTime`, so the
 * returned document neither needs to nor should change row identity.
 *
 * The second parameter carries a shard-scoped reader. Without it a transform
 * could only rewrite the row it was handed — enough for a backfill whose new
 * value is a pure function of the old row (`displayName = name ?? "Anonymous"`),
 * but not for the shape people actually write: read the parent, copy a field
 * down onto its children.
 *
 * May return a promise, since a cross-table read is asynchronous.
 *
 * **A shard key cannot be backfilled this way, even with a reader.** A row whose
 * shard-key field is unset does not belong to any shard, so a shard-scoped query
 * will not enumerate it; and writing the key would have to MOVE the row to a
 * different Durable Object, which a per-shard runner cannot do. Re-keying is an
 * export → transform → import, not a migration.
 */
export type MigrationTransform = (
    document: MigrationDocument,
    // eslint-disable-next-line unicorn/prevent-abbreviations -- reads as `up: (doc, ctx) => …` at every authoring site, matching the procedure handlers' `ctx`
    ctx: MigrationCtx,
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- public API: `void` lets a transform with no return statement type-check; `undefined` alone wouldn't accept a `(): void` arrow
) => MigrationDocument | Promise<MigrationDocument | undefined | void> | undefined | void;

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
    readonly __lunoraMigration: true;
}

/** Declare an online data migration. See the module docs for runtime semantics. */
export const defineMigration = (definition: MigrationDefinition): RegisteredMigration => {
    if (definition.id.trim() === "") {
        throw new LunoraError("INTERNAL", "defineMigration: `id` must be a non-empty string");
    }

    return { __lunoraMigration: true, ...definition };
};
