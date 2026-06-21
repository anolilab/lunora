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
    delete(id: string, expectedTable?: string): Promise<void>;
    // Optional: some writers (e.g. the `.global()` path) have no batch method and
    // delete row-by-row instead, mirroring `@lunora/do`'s `DatabaseWriterLike`.
    deleteMany?(ids: ReadonlyArray<string>, options?: { limit?: number }, expectedTable?: string): Promise<{ deleted: number }>;
    findFirst(tableName: string, args?: unknown): Promise<unknown>;
    findFirstOrThrow(tableName: string, args?: unknown): Promise<unknown>;
    findMany(tableName: string, args?: unknown): Promise<unknown>;
    get(id: string, expectedTable?: string): Promise<unknown>;
    groupBy(tableName: string, options: unknown): Promise<unknown>;
    insert(tableName: string, document: Record<string, unknown>): Promise<string>;
    // Optional: see `deleteMany` above — not every writer provides a batch insert.
    insertMany?(tableName: string, documents: ReadonlyArray<Record<string, unknown>>, options?: { limit?: number }): Promise<string[]>;
    patch(id: string, patch: Record<string, unknown>, expectedTable?: string): Promise<void>;
    // Optional: see `deleteMany` above.
    patchMany?(patches: ReadonlyArray<{ id: string; patch: Record<string, unknown> }>, options?: { limit?: number }, expectedTable?: string): Promise<void>;
    query(tableName: string): { withSearchIndex(indexName: string, search: (q: unknown) => unknown): unknown };
    rank(tableName: string, indexName: string, options: unknown): Promise<unknown>;
    rankPage(tableName: string, indexName: string, options?: unknown): Promise<unknown>;
    replace(id: string, document: Record<string, unknown>, expectedTable?: string): Promise<void>;
}
/* eslint-enable @typescript-eslint/method-signature-style */

/** The per-table accessor object returned for the `ctx.db` table form. */
export interface FacadeEntry {
    aggregate: (options: unknown) => Promise<unknown>;
    count: (where?: unknown) => Promise<number>;
    delete: (id: string) => Promise<void>;
    deleteMany: (ids: ReadonlyArray<string>, options?: { limit?: number }) => Promise<{ deleted: number }>;
    findFirst: (args?: unknown) => Promise<unknown>;
    findFirstOrThrow: (args?: unknown) => Promise<unknown>;
    findMany: (args?: unknown) => Promise<unknown>;
    get: (id: string) => Promise<unknown>;
    groupBy: (options: unknown) => Promise<unknown>;
    insert: (document: Record<string, unknown>) => Promise<string>;
    insertMany: (documents: ReadonlyArray<Record<string, unknown>>, options?: { limit?: number }) => Promise<string[]>;
    // NOTE: `insertManyUnsafe` is DELIBERATELY absent from the per-table facade
    // (and `ctx.orm`). It's a trusted, validation/trigger-skipping escape hatch and
    // stays on the flat top-level `ctx.db.insertManyUnsafe(table, …)` only — it
    // should not get an ergonomic `ctx.db.<table>.*` accessor that invites casual
    // use. Keep it off `FacadeEntry`/`FacadeWriterLike` on purpose; do not "add it
    // for parity".
    patch: (id: string, patch: Record<string, unknown>) => Promise<void>;
    patchMany: (patches: ReadonlyArray<{ id: string; values: Record<string, unknown> }>, options?: { limit?: number }) => Promise<void>;
    rank: (indexName: string, options: unknown) => Promise<unknown>;
    rankPage: (indexName: string, options?: unknown) => Promise<unknown>;
    replace: (id: string, document: Record<string, unknown>) => Promise<void>;
    withSearchIndex: (indexName: string, search: (q: unknown) => unknown) => unknown;
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
    return {
        aggregate: (options) => writer.aggregate(tableName, options),
        count: (where) => writer.count(tableName, where),
        delete: (id) => writer.delete(id, tableName),
        // `deleteMany`/`patchMany` forward the bound `tableName` as `expectedTable`
        // (threaded through the writer + the RLS middleware's per-id gate) so every
        // batched id is scoped to this table — the same IDOR guard the single-row
        // `delete`/`patch` apply. `patchMany` maps the facade's `values` payload to
        // the writer's `{ id, patch }` shape.
        deleteMany: (ids, options) => {
            if (writer.deleteMany === undefined) {
                throw new Error(`ctx.db.${tableName}.deleteMany is unavailable: this writer has no batch delete`);
            }

            return writer.deleteMany(ids, options, tableName);
        },
        findFirst: (args) => writer.findFirst(tableName, args),
        findFirstOrThrow: (args) => writer.findFirstOrThrow(tableName, args),
        findMany: (args) => writer.findMany(tableName, args),
        get: (id) => writer.get(id, tableName),
        groupBy: (options) => writer.groupBy(tableName, options),
        insert: (document) => writer.insert(tableName, document),
        insertMany: (documents, options) => {
            if (writer.insertMany === undefined) {
                throw new Error(`ctx.db.${tableName}.insertMany is unavailable: this writer has no batch insert`);
            }

            return writer.insertMany(tableName, documents, options);
        },
        patch: (id, patch) => writer.patch(id, patch, tableName),
        patchMany: (patches, options) => {
            if (writer.patchMany === undefined) {
                throw new Error(`ctx.db.${tableName}.patchMany is unavailable: this writer has no batch patch`);
            }

            return writer.patchMany(
                patches.map((entry) => {
                    return { id: entry.id, patch: entry.values };
                }),
                options,
                tableName,
            );
        },
        rank: (indexName, options) => writer.rank(tableName, indexName, options),
        rankPage: (indexName, options) => writer.rankPage(tableName, indexName, options),
        replace: (id, document) => writer.replace(id, document, tableName),
        withSearchIndex: (indexName, search) => writer.query(tableName).withSearchIndex(indexName, search),
    };
};

/** The kitcn-style `ctx.orm` namespace over a per-table facade map. */
export interface OrmLike {
    delete: (table: string, id: string) => Promise<void>;
    insert: (table: string) => { values: (document: Record<string, unknown>) => Promise<string> };
    query: Record<string, FacadeEntry>;
    replace: (table: string, id: string) => { with: (document: Record<string, unknown>) => Promise<void> };
    update: (table: string, id: string) => { set: (values: Record<string, unknown>) => Promise<void> };
}

/** Build `ctx.orm` over a per-table facade map (table name → FacadeEntry). */
export const bindOrm = (facade: Record<string, FacadeEntry>): OrmLike => {
    const resolve = (table: string): FacadeEntry => {
        const bound = facade[table];

        if (!bound) {
            throw new Error(`unknown table: ${table}`);
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
