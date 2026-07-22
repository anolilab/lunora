/**
 * The per-table `ctx.db` accessor (the `ctx.db.messages.findMany(...)` form) and
 * the kitcn-style `ctx.orm` namespace, as plain runtime helpers. This is the ONE
 * source of truth for the facade shape, shared by two callers so they can never
 * drift (a drift here is security-relevant — a facade accessor the RLS
 * middleware forgot to re-bind would read around policy). `@lunora/codegen`
 * emits `ctx.db`/`ctx.orm` by calling these over the raw shard writer (and the
 * D1 `globalDb` writer for `.global()` tables); the RLS middleware re-binds the
 * policy tables by calling them over the policy-enforcing wrapped writer.
 *
 * `bindTableFacade(writer, table)` pins `tableName` on the structural writer so
 * callers address rows by id (`get`/`delete`/`patch`/`replace`) or by the bound
 * table (everything else). The binding is identical regardless of which writer
 * is passed — that's the whole point.
 */
import { LunoraError } from "@lunora/errors";

/**
 * Structural detector for `@lunora/do`'s `ConflictError(kind: "unique")`. The
 * facade must not take a runtime dependency on `@lunora/do`, so it recognises a
 * UNIQUE-constraint breach by the error's own `code`/`kind` properties (declared
 * own-properties precisely so cross-package callers can match the shape without
 * an `instanceof`). Used by the `skipDuplicates` insert path.
 */
const isUniqueConflict = (error: unknown): boolean =>
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "CONFLICT" && (error as { kind?: unknown }).kind === "unique";

/**
 * Build the `where` tree that locates an existing row for `upsert`: one equality
 * per `target` field, read from the `create` document. Throws when a target
 * field is absent (an upsert with no value to match on would silently match the
 * wrong rows). Multiple keys on one object compose as an implicit AND.
 */
const buildUpsertWhere = (tableName: string, target: ReadonlyArray<string> | string, create: Record<string, unknown>): Record<string, unknown> => {
    const fields = typeof target === "string" ? [target] : target;

    if (fields.length === 0) {
        throw new LunoraError("INTERNAL", `ctx.db.${tableName}.upsert: "target" must name at least one field`);
    }

    const where: Record<string, unknown> = {};

    for (const field of fields) {
        if (!(field in create)) {
            throw new LunoraError("INTERNAL", `ctx.db.${tableName}.upsert: target field "${field}" is missing from the create document`);
        }

        where[field] = create[field];
    }

    return where;
};

/**
 * Minimal structural writer the facade binds over. Declared with **method**
 * syntax (not arrow properties) so a more-specifically-typed writer — both
 * `@lunora/do`'s `DatabaseWriterLike` and the RLS middleware's wrapped writer —
 * stays assignable under bivariant parameter checking. That is the whole reason
 * the shared helper can serve both callers, hence the rule exemption.
 */
/* eslint-disable @typescript-eslint/method-signature-style -- bivariant params: a more-specifically-typed writer must stay assignable to this structural type */
export interface FacadeWriterLike {
    aggregate(tableName: string, options: unknown): Promise<unknown>;
    count(tableName: string, where?: unknown): Promise<number>;
    delete(id: string, expectedTable?: string, options?: { hard?: boolean }): Promise<void>;
    // Optional: some writers (e.g. the `.global()` path) have no batch method and
    // delete row-by-row instead, mirroring `@lunora/do`'s `DatabaseWriterLike`.
    deleteMany?(ids: ReadonlyArray<string>, options?: { limit?: number }, expectedTable?: string): Promise<{ deleted: number }>;
    deleteWhere?(tableName: string, where: Record<string, unknown>, options?: { limit?: number }): Promise<{ deleted: number }>;
    findFirst(tableName: string, args?: unknown): Promise<unknown>;
    findFirstOrThrow(tableName: string, args?: unknown): Promise<unknown>;
    findMany(tableName: string, args?: unknown): Promise<unknown>;
    get(id: string, expectedTable?: string): Promise<unknown>;
    groupBy(tableName: string, options: unknown): Promise<unknown>;
    insert(tableName: string, document: Record<string, unknown>): Promise<string>;
    // Optional: see `deleteMany` above — not every writer provides a batch insert.
    // Returns (id | null)[] so skipDuplicates can slot nulls in input order; the
    // typed facade narrows to Id<T>[] when skipDuplicates is not requested.
    insertMany?(
        tableName: string,
        documents: ReadonlyArray<Record<string, unknown>>,
        options?: { limit?: number; skipDuplicates?: boolean },
    ): Promise<(string | null)[]>;
    patch(id: string, patch: Record<string, unknown>, expectedTable?: string): Promise<void>;
    // Optional: see `deleteMany` above.
    patchMany?(
        patches: ReadonlyArray<{ id: string; patch: Record<string, unknown> }>,
        options?: { limit?: number },
        expectedTable?: string,
    ): Promise<{ patched: number }>;
    patchWhere?(
        tableName: string,
        args: { patch: Record<string, unknown>; where: Record<string, unknown> },
        options?: { limit?: number },
    ): Promise<{ patched: number }>;
    query(tableName: string): {
        withGeoIndex(indexName: string, build: (q: unknown) => unknown): unknown;
        withSearchIndex(indexName: string, search: (q: unknown) => unknown): unknown;
    };
    rank(tableName: string, indexName: string, options: unknown): Promise<unknown>;
    rankPage(tableName: string, indexName: string, options?: unknown): Promise<unknown>;
    replace(id: string, document: Record<string, unknown>, expectedTable?: string): Promise<void>;
    // Optional: only writers over a `.softDelete()` schema implement it.
    restore?(id: string, expectedTable?: string): Promise<void>;
}
/* eslint-enable @typescript-eslint/method-signature-style */

/** The per-table accessor object returned for the `ctx.db` table form. */
export interface FacadeEntry {
    aggregate: (options: unknown) => Promise<unknown>;
    count: (where?: unknown) => Promise<number>;
    delete: (id: string) => Promise<void>;
    deleteMany: {
        (ids: ReadonlyArray<string>, options?: { limit?: number }): Promise<{ deleted: number }>;
        (args: { limit?: number; where: Record<string, unknown> }): Promise<{ deleted: number }>;
    };
    /** `true` when at least one row matches `where` (or any row exists when omitted). Honors RLS like `findFirst`. */
    exists: (where?: unknown) => Promise<boolean>;
    findFirst: (args?: unknown) => Promise<unknown>;
    findFirstOrThrow: (args?: unknown) => Promise<unknown>;
    findMany: (args?: unknown) => Promise<unknown>;
    get: (id: string) => Promise<unknown>;
    groupBy: (options: unknown) => Promise<unknown>;
    /** Physically remove a row (and physically cascade), bypassing `.softDelete()`. */
    hardDelete: (id: string) => Promise<void>;
    insert: (document: Record<string, unknown>, options?: FacadeInsertOptions) => Promise<null | string>;

    /**
     * Insert many documents into this table in one call. With
     * `{ skipDuplicates: true }`, UNIQUE breaches resolve to `null` for that row
     * instead of failing the batch. The typed facade narrows the return to
     * `Id&lt;T>[]` when skipDuplicates is not requested.
     */
    insertMany: (documents: ReadonlyArray<Record<string, unknown>>, options?: { limit?: number; skipDuplicates?: boolean }) => Promise<(string | null)[]>;
    // NOTE: `insertManyUnsafe` is DELIBERATELY absent from the per-table facade
    // (and `ctx.orm`). It's a trusted, validation/trigger-skipping escape hatch and
    // stays on the flat top-level `ctx.db.insertManyUnsafe(table, …)` only — it
    // should not get an ergonomic `ctx.db.<table>.*` accessor that invites casual
    // use. Keep it off `FacadeEntry`/`FacadeWriterLike` on purpose; do not "add it
    // for parity".
    patch: (id: string, patch: Record<string, unknown>) => Promise<void>;
    patchMany: {
        (patches: ReadonlyArray<{ id: string; values: Record<string, unknown> }>, options?: { limit?: number }): Promise<{ patched: number }>;
        (args: { limit?: number; values: Record<string, unknown>; where: Record<string, unknown> }): Promise<{ patched: number }>;
    };
    rank: (indexName: string, options: unknown) => Promise<unknown>;
    rankPage: (indexName: string, options?: unknown) => Promise<unknown>;
    replace: (id: string, document: Record<string, unknown>) => Promise<void>;
    /** Un-soft-delete a row: clears the `.softDelete()` marker (by-id, so it reaches a row list reads hide). */
    restore: (id: string) => Promise<void>;
    /** Insert when no row matches `target`, else patch the match. Composes `findFirst` + `insert`/`patch`, so RLS applies to each step. */
    upsert: (args: UpsertArgs) => Promise<UpsertResult>;
    /** Sequential `upsert` over many rows sharing one `target`; returns one result per input row in order. */
    upsertMany: (args: UpsertManyArgs) => Promise<UpsertResult[]>;
    withGeoIndex: (indexName: string, build: (q: unknown) => unknown) => unknown;
    withSearchIndex: (indexName: string, search: (q: unknown) => unknown) => unknown;
}

/** Options accepted by the per-table `insert` accessor. */
export interface FacadeInsertOptions {
    /**
     * When `true`, a UNIQUE-constraint breach is swallowed: the insert becomes a
     * silent no-op and resolves to `null` instead of throwing a `CONFLICT`. Any
     * other error still propagates. Mirrors better-drizzle's `create({ skipDuplicates })`.
     */
    skipDuplicates?: boolean;
}

/** The conflict target for `upsert`/`upsertMany`: one field name or a tuple of them. */
export type UpsertTarget = ReadonlyArray<string> | string;

/** Argument to the per-table `upsert` accessor. */
export interface UpsertArgs {
    /** Document inserted when no existing row matches the `target`. */
    create: Record<string, unknown>;
    /** Field(s) — typically a `.unique()` column or unique index — used to look up an existing row. */
    target: UpsertTarget;
    /** Patch applied when an existing row matches the `target`. Defaults to `create`. */
    update?: Record<string, unknown>;
}

/** Result of an `upsert`: the row's id and whether it was freshly inserted (`true`) or updated (`false`). */
export interface UpsertResult {
    created: boolean;
    id: string;
}

/** Argument to the per-table `upsertMany` accessor — a shared `target` plus per-row create/update payloads. */
export interface UpsertManyArgs {
    rows: ReadonlyArray<{ create: Record<string, unknown>; update?: Record<string, unknown> }>;
    target: UpsertTarget;
}

/**
 * Bind a structural writer to one table, producing its `ctx.db` table accessor.
 *
 * The by-id accessors (`get`/`delete`/`patch`/`replace`) forward the bound
 * `tableName` as `expectedTable` so the underlying writer scopes its id lookup
 * to this table. Without it, a branded `Id&lt;"posts">` carrying another table's
 * id would resolve cross-table (the writer probes every table by id), letting
 * `ctx.db.posts.get(foreignId)` read — or `.delete`/`.patch`/`.replace`
 * mutate — a row in an unrelated table (IDOR). Writers that ignore the second
 * argument keep their previous global behaviour; the scoping is opt-in via this
 * forwarded name.
 */
export const bindTableFacade = (writer: FacadeWriterLike, tableName: string): FacadeEntry => {
    // Insert + skipDuplicates: on a UNIQUE breach the insert resolves to `null`
    // instead of throwing. Routes through the bound `writer.insert`, so when this
    // facade is re-bound over the RLS-wrapped writer the insert policy still runs
    // *before* the constraint check.
    const insert = async (document: Record<string, unknown>, options?: FacadeInsertOptions): Promise<null | string> => {
        if (options?.skipDuplicates !== true) {
            return writer.insert(tableName, document);
        }

        try {
            return await writer.insert(tableName, document);
        } catch (error) {
            if (isUniqueConflict(error)) {
                // eslint-disable-next-line unicorn/no-null -- skipDuplicates resolves to `null` when the row already exists, mirroring better-drizzle's create()
                return null;
            }

            throw error;
        }
    };

    // Insert-or-update keyed by `target`. Both the lookup and the write go
    // through the bound `writer.*`, so each step is RLS-checked when this facade
    // is bound over the wrapped writer (a hidden row simply isn't found, and the
    // insert/patch is gated by its own policy). The `tableName` passed to `patch`
    // scopes the by-id write to this table (the same IDOR guard as `patch`).
    const upsert = async ({ create, target, update }: UpsertArgs): Promise<UpsertResult> => {
        const where = buildUpsertWhere(tableName, target, create);
        const existing = (await writer.findFirst(tableName, { where })) as null | Record<string, unknown>;

        if (existing && typeof existing["_id"] === "string") {
            await writer.patch(existing["_id"], update ?? create, tableName);

            return { created: false, id: existing["_id"] };
        }

        const id = await writer.insert(tableName, create);

        return { created: true, id };
    };

    return {
        aggregate: (options) => writer.aggregate(tableName, options),
        count: (where) => writer.count(tableName, where),
        delete: (id) => writer.delete(id, tableName),
        // `deleteMany`/`patchMany` forward the bound `tableName` as `expectedTable`
        // for id-based calls (threaded through the writer + the RLS middleware's
        // per-id gate) so every batched id is scoped to this table — the same IDOR
        // guard the single-row `delete`/`patch` apply. The where-based form routes
        // through the structural writer's `deleteMany(tableName, { where })`.
        // `patchMany` maps the facade's `values` payload to the writer's
        // `{ id, patch }` shape.
        deleteMany: (first: ReadonlyArray<string> | { limit?: number; where: Record<string, unknown> }, options?: { limit?: number }) => {
            if (Array.isArray(first)) {
                if (writer.deleteMany === undefined) {
                    throw new LunoraError("INTERNAL", `ctx.db.${tableName}.deleteMany is unavailable: this writer has no batch delete`);
                }

                return writer.deleteMany(first, options, tableName);
            }

            if (writer.deleteWhere === undefined) {
                throw new LunoraError("INTERNAL", `ctx.db.${tableName}.deleteMany({ where }) is unavailable: this writer has no where-based delete`);
            }

            const whereArgs = first as { limit?: number; where: Record<string, unknown> };

            return writer.deleteWhere(tableName, whereArgs.where, { limit: whereArgs.limit });
        },
        // `exists` reuses `findFirst` (RLS-filtered, indexed when a `.withIndex`-able
        // `where` is supplied) and only asks whether a row came back — no count scan.
        exists: async (where) => (await writer.findFirst(tableName, where === undefined ? undefined : { where })) !== null,
        findFirst: (args) => writer.findFirst(tableName, args),
        findFirstOrThrow: (args) => writer.findFirstOrThrow(tableName, args),
        findMany: (args) => writer.findMany(tableName, args),
        get: (id) => writer.get(id, tableName),
        groupBy: (options) => writer.groupBy(tableName, options),
        // Physical removal — bypasses `.softDelete()`. RLS gates it as a delete.
        hardDelete: (id) => writer.delete(id, tableName, { hard: true }),
        insert,
        insertMany: (documents: ReadonlyArray<Record<string, unknown>>, options?: { limit?: number; skipDuplicates?: boolean }) => {
            if (writer.insertMany === undefined) {
                throw new LunoraError("INTERNAL", `ctx.db.${tableName}.insertMany is unavailable: this writer has no batch insert`);
            }

            return writer.insertMany(tableName, documents, options);
        },
        patch: (id, patch) => writer.patch(id, patch, tableName),
        patchMany: (
            first:
                | ReadonlyArray<{ id: string; values: Record<string, unknown> }>
                | { limit?: number; values: Record<string, unknown>; where: Record<string, unknown> },
            options?: { limit?: number },
        ) => {
            if (Array.isArray(first)) {
                if (writer.patchMany === undefined) {
                    throw new LunoraError("INTERNAL", `ctx.db.${tableName}.patchMany is unavailable: this writer has no batch patch`);
                }

                return writer.patchMany(
                    first.map((entry: { id: string; values: Record<string, unknown> }) => {
                        return { id: entry.id, patch: entry.values };
                    }),
                    options,
                    tableName,
                );
            }

            if (writer.patchWhere === undefined) {
                throw new LunoraError("INTERNAL", `ctx.db.${tableName}.patchMany({ where, values }) is unavailable: this writer has no where-based patch`);
            }

            const whereArgs = first as { limit?: number; values: Record<string, unknown>; where: Record<string, unknown> };

            return writer.patchWhere(tableName, { patch: whereArgs.values, where: whereArgs.where }, { limit: whereArgs.limit });
        },
        rank: (indexName, options) => writer.rank(tableName, indexName, options),
        rankPage: (indexName, options) => writer.rankPage(tableName, indexName, options),
        replace: (id, document) => writer.replace(id, document, tableName),
        restore: async (id) => {
            if (!writer.restore) {
                throw new LunoraError("INTERNAL", `ctx.db.${tableName}.restore is unavailable: this writer has no restore (is the table .softDelete()?)`);
            }

            await writer.restore(id, tableName);
        },
        upsert,
        upsertMany: async ({ rows, target }) => {
            // Sequential so each upsert sees the prior one's write (two rows that
            // collide on `target` within one batch land as insert-then-update, not
            // two inserts that breach the constraint). Atomic within a mutation via
            // the DO's BEGIN/COMMIT span, exactly like `insertMany`/`patchMany`.
            const results: UpsertResult[] = [];

            for (const row of rows) {
                // eslint-disable-next-line no-await-in-loop -- sequential by design: a later row may upsert a row an earlier one just created
                results.push(await upsert({ create: row.create, target, update: row.update }));
            }

            return results;
        },
        withGeoIndex: (indexName, build) => writer.query(tableName).withGeoIndex(indexName, build),
        withSearchIndex: (indexName, search) => writer.query(tableName).withSearchIndex(indexName, search),
    };
};

/** The kitcn-style `ctx.orm` namespace over a per-table facade map. */
export interface OrmLike {
    delete: (table: string, id: string) => Promise<void>;
    insert: (table: string) => { values: (document: Record<string, unknown>) => Promise<null | string> };
    query: Record<string, FacadeEntry>;
    replace: (table: string, id: string) => { with: (document: Record<string, unknown>) => Promise<void> };
    update: (table: string, id: string) => { set: (values: Record<string, unknown>) => Promise<void> };
}

/** Build `ctx.orm` over a per-table facade map (table name → FacadeEntry). */
export const bindOrm = (facade: Record<string, FacadeEntry>): OrmLike => {
    const resolve = (table: string): FacadeEntry => {
        const bound = facade[table];

        if (!bound) {
            throw new LunoraError("INTERNAL", `unknown table: ${table}`);
        }

        return bound;
    };

    return {
        delete: (table, id) => resolve(table).delete(id),
        insert: (table) => {
            return { values: (document) => resolve(table).insert(document) };
        },
        query: facade,
        replace: (table, id) => {
            return { with: (document) => resolve(table).replace(id, document) };
        },
        update: (table, id) => {
            return { set: (values) => resolve(table).patch(id, values) };
        },
    };
};
