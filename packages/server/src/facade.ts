/**
 * The per-table `ctx.db` accessor (the `ctx.db.messages.findMany(...)` form) and
 * the kitcn-style `ctx.orm` namespace, as plain runtime helpers. This is the ONE
 * source of truth for the facade shape, shared by two callers so they can never
 * drift (a drift here is security-relevant — a facade accessor the RLS
 * middleware forgot to re-bind would read around policy). `@cirrus/codegen`
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
 * `@cirrus/do`'s `DatabaseWriterLike` and the RLS middleware's wrapped writer —
 * stays assignable under bivariant parameter checking. That is the whole reason
 * the shared helper can serve both callers, hence the rule exemption.
 */
/* eslint-disable @typescript-eslint/method-signature-style -- bivariant params: a more-specifically-typed writer must stay assignable to this structural type */
export interface FacadeWriterLike {
    aggregate(tableName: string, options: unknown): Promise<unknown>;
    count(tableName: string, where?: unknown): Promise<number>;
    delete(id: string): Promise<void>;
    findFirst(tableName: string, args?: unknown): Promise<unknown>;
    findFirstOrThrow(tableName: string, args?: unknown): Promise<unknown>;
    findMany(tableName: string, args?: unknown): Promise<unknown>;
    get(id: string): Promise<unknown>;
    groupBy(tableName: string, options: unknown): Promise<unknown>;
    insert(tableName: string, document: Record<string, unknown>): Promise<string>;
    patch(id: string, patch: Record<string, unknown>): Promise<void>;
    query(tableName: string): { withSearchIndex(indexName: string, search: (q: unknown) => unknown): unknown };
    rank(tableName: string, indexName: string, options: unknown): Promise<unknown>;
    rankPage(tableName: string, indexName: string, options?: unknown): Promise<unknown>;
    replace(id: string, document: Record<string, unknown>): Promise<void>;
}
/* eslint-enable @typescript-eslint/method-signature-style */

/** The per-table accessor object returned for the `ctx.db` table form. */
export interface FacadeEntry {
    aggregate: (options: unknown) => Promise<unknown>;
    count: (where?: unknown) => Promise<number>;
    delete: (id: string) => Promise<void>;
    findFirst: (args?: unknown) => Promise<unknown>;
    findFirstOrThrow: (args?: unknown) => Promise<unknown>;
    findMany: (args?: unknown) => Promise<unknown>;
    get: (id: string) => Promise<unknown>;
    groupBy: (options: unknown) => Promise<unknown>;
    insert: (document: Record<string, unknown>) => Promise<string>;
    patch: (id: string, patch: Record<string, unknown>) => Promise<void>;
    rank: (indexName: string, options: unknown) => Promise<unknown>;
    rankPage: (indexName: string, options?: unknown) => Promise<unknown>;
    replace: (id: string, document: Record<string, unknown>) => Promise<void>;
    withSearchIndex: (indexName: string, search: (q: unknown) => unknown) => unknown;
}

/** Bind a structural writer to one table, producing its `ctx.db` table accessor. */
export const bindTableFacade = (writer: FacadeWriterLike, tableName: string): FacadeEntry => {
    return {
        aggregate: (options) => writer.aggregate(tableName, options),
        count: (where) => writer.count(tableName, where),
        delete: (id) => writer.delete(id),
        findFirst: (args) => writer.findFirst(tableName, args),
        findFirstOrThrow: (args) => writer.findFirstOrThrow(tableName, args),
        findMany: (args) => writer.findMany(tableName, args),
        get: (id) => writer.get(id),
        groupBy: (options) => writer.groupBy(tableName, options),
        insert: (document) => writer.insert(tableName, document),
        patch: (id, patch) => writer.patch(id, patch),
        rank: (indexName, options) => writer.rank(tableName, indexName, options),
        rankPage: (indexName, options) => writer.rankPage(tableName, indexName, options),
        replace: (id, document) => writer.replace(id, document),
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
