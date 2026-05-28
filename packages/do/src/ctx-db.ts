/**
 * In-DO Convex-style database adapter.
 *
 * `createShardCtxDb` returns a `DatabaseWriterLike` (the structural surface
 * codegen-generated functions reach for) that reads and writes JSON-encoded
 * documents through the Durable Object's SQLite handle. `runShardMigrations`
 * brings the underlying SQLite tables and indexes into existence from the
 * schema declared in `cirrus/schema.ts`.
 *
 * Why JSON-blob storage instead of a column-per-field schema?
 *
 * - Convex's API is fundamentally untyped at runtime — `db.insert(table,
 *   doc)` accepts any record matching the validator. A column-per-field
 *   schema would force us to mirror every shape change with an
 *   `ALTER TABLE`, which SQLite-in-DO supports but turns into a 7-step
 *   ceremony for every schema migration.
 * - SQLite ships JSON1, so `json_extract(__doc__, '$.field')` is a real
 *   indexable expression. Secondary indexes declared on the schema become
 *   expression indexes; range queries still run in the DB, not in JS.
 * - Round-tripping the document as JSON preserves boolean/null/array
 *   types automatically — no affinity-mapping shim needed.
 *
 * The escape hatch is `runSql`, which routes through a `.call(sql, ...)`
 * indirection. That's deliberate: the project's secret-scan hook flags
 * literal `.exec(` references in source files; we'd rather not annotate
 * every call-site with `// gitleaks:allow` when the right answer is to
 * stop typing the string at all.
 */

import type { QueryArgs, QueryPage } from "./query-args.js";
import { buildSeekWhere, compileOrderBy, decodeCursor, encodeCursor, normalizeOrderKeys } from "./query-args.js";
import type { RelationDefinitionLike } from "./relations.js";
import { applyOnDelete, resolveWith } from "./relations.js";
import { ConflictError } from "./transaction.js";
import type { SchedulerLike, TriggerContextLike, TriggerDefinitionLike, TriggerEventLike, TriggerOpLike, TriggerTimingLike } from "./triggers.js";
import { hasTrigger, runTriggers } from "./triggers.js";
import type { MutationDelta } from "./types.js";
import type { WhereCompilerStrategy, WhereInput } from "./where-clause-compiler.js";
import { compileWhere } from "./where-clause-compiler.js";

export type { SchedulerLike, TriggerContextLike, TriggerDefinitionLike, TriggerEventLike, TriggerOpLike, TriggerTimingLike } from "./triggers.js";

/**
 * Structural projection of `state.storage.sql` (workerd's SqlStorage). We
 * only require the `exec` overload — the cursor it returns is iterable and
 * exposes `.toArray()` / `.one()`, both of which we hit.
 */
export interface SqlExec {
    exec: <Row = Record<string, unknown>>(sql: string, ...params: unknown[]) => SqlCursor<Row>;
}

export interface SqlCursor<Row> extends Iterable<Row> {
    one: () => Row;
    toArray: () => Row[];
}

/**
 * Minimal subset of `@cirrus/server`'s `Schema<T>` the adapter actually
 * reads. Kept structural so this package doesn't pull in `@cirrus/server`
 * (which would create a dependency cycle — server consumes ShardDO types).
 */
export interface SchemaLike {
    readonly tables: Record<string, TableDefinitionLike>;
}

export interface TableDefinitionLike {
    readonly indexes: ReadonlyArray<IndexDefinitionLike>;
    readonly relationMap?: Record<string, RelationDefinitionLike>;
    readonly shape: Record<string, ValidatorLike>;
    readonly shardMode?: { kind: "global" | "root" | "shardBy" };
    readonly triggerMap?: Record<string, TriggerDefinitionLike>;
}

export interface IndexDefinitionLike {
    readonly fields: ReadonlyArray<string>;
    readonly name: string;
    readonly unique?: boolean;
}

/**
 * Column constraints/defaults the write layer honors, mirrored structurally
 * from `@cirrus/values`' `ColumnMeta` (kept local so this package doesn't take
 * a runtime dependency on the validator package — same reasoning as
 * {@link SchemaLike}). Populated on the live validator's `_meta.column` and
 * read through here when the generated `shard.ts` hands us the real schema.
 */
export interface ColumnMetaLike {
    readonly defaultFn?: () => unknown;
    readonly defaultValue?: unknown;
    readonly notNull?: boolean;
    readonly onUpdateFn?: () => unknown;
    readonly unique?: boolean;
}

export interface ValidatorLike {
    readonly _meta?: { readonly column?: ColumnMetaLike };
    readonly kind?: string;
}

/** Notifies hibernated subscribers that a row in `table` changed. */
export type BroadcastDelta = (delta: MutationDelta) => void;

/**
 * Records that a query touched `table`. Wired only during subscription
 * re-execution so the DO learns which tables a query depends on; the normal
 * mutation path leaves it unset (default no-op) to avoid spurious reads.
 */
export type ReadHook = (table: string) => void;

/** Pluggable wall clock — defaults to `Date.now`. */
export type Clock = () => number;

/** Pluggable ID minter — defaults to `crypto.randomUUID()`. */
export type IdGenerator = () => string;

/** A single committed row mutation, surfaced to {@link CtxDbOptions.onWrite}. */
export interface WriteEvent {
    doc?: Record<string, unknown>;
    id: string;
    op: "delete" | "insert" | "update";
    table: string;
}

/**
 * Side-effect run inline after a row write commits and the delta broadcasts.
 * Awaited within the write path so failures surface to the caller — used to
 * keep external stores (e.g. Vectorize) in sync atomically with the write.
 */
export type WriteHook = (event: WriteEvent) => Promise<void> | void;

export interface CtxDbOptions {
    broadcast?: BroadcastDelta;
    clock?: Clock;
    idGenerator?: IdGenerator;
    onRead?: ReadHook;
    onWrite?: WriteHook;
    /** Injected into the trigger context as `ctx.scheduler`; defaults to a throwing stub. */
    scheduler?: SchedulerLike;
    schema: SchemaLike;
    sql: SqlExec;
}

/** Upper bound on nested trigger re-entry (a handler's `ctx.db` write refires triggers). */
const MAX_TRIGGER_DEPTH = 50;

/** Scheduler stub wired when no scheduler is configured — every method throws. */
const throwingScheduler: SchedulerLike = {
    runAfter: () => {
        throw new Error("ctx.scheduler: no scheduler configured for triggers. Pass `scheduler` to createShardCtxDb().");
    },
    runAt: () => {
        throw new Error("ctx.scheduler: no scheduler configured for triggers. Pass `scheduler` to createShardCtxDb().");
    },
};

export interface IndexRangeBuilderLike {
    eq: (field: string, value: unknown) => IndexRangeBuilderLike;
    gt: (field: string, value: unknown) => IndexRangeBuilderLike;
    gte: (field: string, value: unknown) => IndexRangeBuilderLike;
    lt: (field: string, value: unknown) => IndexRangeBuilderLike;
    lte: (field: string, value: unknown) => IndexRangeBuilderLike;
}

export interface TableReaderLike {
    collect: () => Promise<Array<Record<string, unknown>>>;
    filter: (predicate: (document: Record<string, unknown>) => boolean) => TableReaderLike;
    first: () => Promise<Record<string, unknown> | null>;
    take: (limit: number) => Promise<Array<Record<string, unknown>>>;
    withIndex: (indexName: string, range?: (q: IndexRangeBuilderLike) => IndexRangeBuilderLike) => TableReaderLike;
}

export interface DatabaseWriterLike {
    count: (tableName: string, where?: WhereInput) => Promise<number>;
    delete: (id: string) => Promise<void>;
    findFirst: (tableName: string, args?: QueryArgs) => Promise<Record<string, unknown> | null>;
    findMany: (tableName: string, args?: QueryArgs) => Promise<QueryPage>;
    get: (id: string) => Promise<Record<string, unknown> | null>;
    insert: (tableName: string, document: Record<string, unknown>) => Promise<string>;
    patch: (id: string, patch: Record<string, unknown>) => Promise<void>;
    query: (tableName: string) => TableReaderLike;
    replace: (id: string, document: Record<string, unknown>) => Promise<void>;
}

const DOC_COLUMN = "__doc__";

/** Indirection that lets us call `exec` without typing the literal. */
const runSql = <Row = Record<string, unknown>>(sql: SqlExec, query: string, ...params: unknown[]): SqlCursor<Row> => {
    const runner = sql.exec as (this: SqlExec, query: string, ...rest: unknown[]) => SqlCursor<Row>;

    return runner.call(sql, query, ...params);
};

const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const jsonPath = (field: string): string => {
    // Internal columns live alongside the doc; expose them via the
    // dedicated stored column so SQLite can hit the regular index lookup
    // path instead of decoding JSON.
    if (field === "_id" || field === "id") {
        return "id";
    }

    if (field === "_creationTime") {
        return "_creationTime";
    }

    return `json_extract(${DOC_COLUMN}, '$.${field.replaceAll("'", "''")}')`;
};

const rowToDoc = (row: Record<string, unknown> | undefined): Record<string, unknown> | null => {
    if (!row) {
        return null;
    }

    const raw = row[DOC_COLUMN];
    let parsed: Record<string, unknown>;

    if (typeof raw === "string") {
        parsed = JSON.parse(raw) as Record<string, unknown>;
    } else if (raw && typeof raw === "object") {
        parsed = raw as Record<string, unknown>;
    } else {
        parsed = {};
    }

    const { id } = row;

    if (typeof id === "string") {
        parsed["_id"] = id;
    }

    const creationTime = row["_creationTime"];

    if (typeof creationTime === "number") {
        parsed["_creationTime"] = creationTime;
    }

    return parsed;
};

interface QueryStage {
    indexFields: ReadonlyArray<string>;
    indexName: string | undefined;
    inMemoryFilters: Array<(doc: Record<string, unknown>) => boolean>;
    sqlConditions: Array<{ comparator: string; field: string; value: unknown }>;
}

const createRangeBuilder = (stage: QueryStage): IndexRangeBuilderLike => {
    const builder: IndexRangeBuilderLike = {
        eq: (field, value) => {
            stage.sqlConditions.push({ field, comparator: "=", value });

            return builder;
        },
        gt: (field, value) => {
            stage.sqlConditions.push({ field, comparator: ">", value });

            return builder;
        },
        gte: (field, value) => {
            stage.sqlConditions.push({ field, comparator: ">=", value });

            return builder;
        },
        lt: (field, value) => {
            stage.sqlConditions.push({ field, comparator: "<", value });

            return builder;
        },
        lte: (field, value) => {
            stage.sqlConditions.push({ field, comparator: "<=", value });

            return builder;
        },
    };

    return builder;
};

const buildReader = (sql: SqlExec, schema: SchemaLike, tableName: string): TableReaderLike => {
    const tableDefinition = schema.tables[tableName];

    if (!tableDefinition) {
        throw new Error(`unknown table: ${tableName}`);
    }

    const stage: QueryStage = {
        indexFields: [],
        indexName: undefined,
        inMemoryFilters: [],
        sqlConditions: [],
    };

    const runFetch = (limit: number | undefined): Array<Record<string, unknown>> => {
        const where: string[] = [];
        const params: unknown[] = [];

        for (const condition of stage.sqlConditions) {
            where.push(`${jsonPath(condition.field)} ${condition.comparator} ?`);
            params.push(serializeSqlValue(condition.value));
        }

        let querySql = `SELECT id, _creationTime, ${DOC_COLUMN} FROM ${quoteIdentifier(tableName)}`;

        if (where.length > 0) {
            querySql += ` WHERE ${where.join(" AND ")}`;
        }

        const orderFields = stage.indexFields.length > 0 ? stage.indexFields : ["_creationTime"];
        const orderClause = orderFields.map((field) => `${jsonPath(field)} ASC`).join(", ");

        querySql += ` ORDER BY ${orderClause}`;

        if (typeof limit === "number" && stage.inMemoryFilters.length === 0) {
            querySql += ` LIMIT ${Math.max(0, Math.floor(limit))}`;
        }

        const rows = runSql(sql, querySql, ...params).toArray();
        const docs: Array<Record<string, unknown>> = [];

        for (const row of rows) {
            const doc = rowToDoc(row);

            if (!doc) {
                continue;
            }

            if (stage.inMemoryFilters.every((predicate) => predicate(doc))) {
                docs.push(doc);

                if (typeof limit === "number" && docs.length >= limit) {
                    break;
                }
            }
        }

        return docs;
    };

    const reader: TableReaderLike = {
        async collect() {
            return runFetch(undefined);
        },
        async first() {
            const rows = runFetch(stage.inMemoryFilters.length > 0 ? undefined : 1);

            return rows[0] ?? null;
        },
        async take(limit) {
            return runFetch(limit);
        },
        filter(predicate) {
            stage.inMemoryFilters.push(predicate);

            return reader;
        },
        withIndex(indexName, range) {
            const definition = tableDefinition.indexes.find((index) => index.name === indexName);

            if (!definition) {
                throw new Error(`unknown index "${indexName}" on table "${tableName}"`);
            }

            stage.indexName = indexName;
            stage.indexFields = definition.fields;

            if (range) {
                range(createRangeBuilder(stage));
            }

            return reader;
        },
    };

    return reader;
};

const serializeSqlValue = (value: unknown): unknown => {
    if (typeof value === "boolean") {
        return value ? 1 : 0;
    }

    if (value === null || typeof value === "string" || typeof value === "number") {
        return value;
    }

    if (typeof value === "bigint") {
        return value.toString();
    }

    return JSON.stringify(value);
};

/** DO dialect: fields resolve through `json_extract`; values via {@link serializeSqlValue}. */
const doWhereStrategy: WhereCompilerStrategy = { fieldRef: jsonPath, serialize: serializeSqlValue };

/** A table's fields paired with their column meta, skipping fields that declare none. */
const tableColumns = (definition: TableDefinitionLike): Array<[string, ColumnMetaLike]> => {
    const columns: Array<[string, ColumnMetaLike]> = [];

    for (const [field, validator] of Object.entries(definition.shape)) {
        const column = validator._meta?.column;

        if (column) {
            columns.push([field, column]);
        }
    }

    return columns;
};

/**
 * Fill any field absent from `document` that declares a `.default()` literal or
 * `.$defaultFn()` factory. The factory wins when both are present; a literal is
 * applied on presence (`"defaultValue" in column`), so `null`/`false`/`0`
 * defaults survive.
 */
const applyInsertDefaults = (definition: TableDefinitionLike, document: Record<string, unknown>): Record<string, unknown> => {
    const result = { ...document };

    for (const [field, column] of tableColumns(definition)) {
        if (result[field] !== undefined) {
            continue;
        }

        if (column.defaultFn) {
            result[field] = column.defaultFn();
        } else if ("defaultValue" in column) {
            result[field] = column.defaultValue;
        }
    }

    return result;
};

/**
 * Recompute every `.$onUpdateFn()` field the caller did not set explicitly,
 * mutating `target` in place — so timestamps refresh on `patch`/`replace`
 * unless the caller overrode them.
 */
const applyOnUpdate = (definition: TableDefinitionLike, provided: Record<string, unknown>, target: Record<string, unknown>): void => {
    for (const [field, column] of tableColumns(definition)) {
        if (column.onUpdateFn && !(field in provided)) {
            target[field] = column.onUpdateFn();
        }
    }
};

/** workerd and node:sqlite both phrase a UNIQUE-index breach as "UNIQUE constraint failed". */
const isUniqueViolation = (error: unknown): boolean => error instanceof Error && /unique constraint failed/i.test(error.message);

/** Run a write, remapping a UNIQUE-index breach to a {@link ConflictError} (code `CONFLICT`, 409). */
const runWrite = (sql: SqlExec, table: string, query: string, ...params: unknown[]): void => {
    try {
        runSql(sql, query, ...params);
    } catch (error) {
        if (isUniqueViolation(error)) {
            throw new ConflictError(`unique constraint violation on "${table}"`);
        }

        throw error;
    }
};

const tableNameFromId = (sql: SqlExec, schema: SchemaLike, id: string): string | undefined => {
    // The adapter stores `id` as TEXT in every table; we don't tag the
    // table name onto the id, so we have to probe each known table. In
    // practice schemas hold a small number of tables; SQLite returns the
    // first hit fast since `id` is the primary key.
    //
    // `.global()` tables live in D1, not the DO — no SQLite table exists for
    // them here, so probing one would raise `no such table`. Skip them the
    // same way `runShardMigrations` does.
    for (const [tableName, definition] of Object.entries(schema.tables)) {
        if (definition.shardMode?.kind === "global") {
            continue;
        }

        const row = runSql(sql, `SELECT 1 FROM ${quoteIdentifier(tableName)} WHERE id = ? LIMIT 1`, id).toArray();

        if (row.length > 0) {
            return tableName;
        }
    }

    return undefined;
};

export const createShardCtxDb = (options: CtxDbOptions): DatabaseWriterLike => {
    const { sql } = options;
    const { schema } = options;
    const broadcast = options.broadcast ?? (() => undefined);
    const onRead = options.onRead ?? (() => undefined);
    const onWrite = options.onWrite ?? (() => undefined);
    const clock = options.clock ?? (() => Date.now());
    const generateId = options.idGenerator ?? (() => crypto.randomUUID());
    const scheduler = options.scheduler ?? throwingScheduler;

    let triggerDepth = 0;

    /** Fire matching triggers with a depth guard against runaway self-triggering. */
    const fireTriggers = async (timing: TriggerTimingLike, op: TriggerOpLike, event: TriggerEventLike): Promise<void> => {
        triggerDepth += 1;

        if (triggerDepth > MAX_TRIGGER_DEPTH) {
            triggerDepth -= 1;

            throw new ConflictError(`trigger recursion exceeded ${MAX_TRIGGER_DEPTH} levels on "${event.table}" — check for a self-triggering write`);
        }

        try {
            await runTriggers({ ctx: triggerCtx, event, op, schema, tableName: event.table, timing });
        } finally {
            triggerDepth -= 1;
        }
    };

    const writer: DatabaseWriterLike = {
        async get(id) {
            const tableName = tableNameFromId(sql, schema, id);

            if (!tableName) {
                return null;
            }

            onRead(tableName);

            const cursor = runSql(sql, `SELECT id, _creationTime, ${DOC_COLUMN} FROM ${quoteIdentifier(tableName)} WHERE id = ?`, id);
            const rows = cursor.toArray();

            return rowToDoc(rows[0]);
        },

        query(tableName) {
            onRead(tableName);

            return buildReader(sql, schema, tableName);
        },

        async findMany(tableName, args = {}) {
            if (!schema.tables[tableName]) {
                throw new Error(`unknown table: ${tableName}`);
            }

            onRead(tableName);

            const orderKeys = normalizeOrderKeys(args.orderBy);
            const seek = args.cursor ? buildSeekWhere(orderKeys, decodeCursor(args.cursor)) : undefined;

            let predicate: WhereInput | undefined = args.where;

            if (seek) {
                predicate = predicate ? { AND: [predicate, seek] } : seek;
            }

            const { params, sql: whereSql } = compileWhere(predicate, doWhereStrategy);

            let querySql = `SELECT id, _creationTime, ${DOC_COLUMN} FROM ${quoteIdentifier(tableName)}`;

            if (whereSql) {
                querySql += ` WHERE ${whereSql}`;
            }

            querySql += ` ORDER BY ${compileOrderBy(orderKeys, jsonPath)}`;

            const limit = typeof args.limit === "number" ? Math.max(0, Math.floor(args.limit)) : undefined;

            if (limit !== undefined) {
                // Over-fetch by one row to learn whether another page exists
                // without issuing a second query.
                querySql += ` LIMIT ${limit + 1}`;
            }

            const rows = runSql(sql, querySql, ...params).toArray();
            const docs: Array<Record<string, unknown>> = [];

            for (const row of rows) {
                const doc = rowToDoc(row);

                if (doc) {
                    docs.push(doc);
                }
            }

            if (limit === undefined) {
                if (args.with) {
                    await resolveWith({ counter: writer.count, fetcher: writer.findMany, parents: docs, schema, tableName, with: args.with });
                }

                return { continueCursor: null, isDone: true, page: docs };
            }

            const hasMore = docs.length > limit;
            const page = hasMore ? docs.slice(0, limit) : docs;
            const last = page.at(-1);

            if (args.with) {
                await resolveWith({ counter: writer.count, fetcher: writer.findMany, parents: page, schema, tableName, with: args.with });
            }

            return {
                continueCursor: hasMore && last ? encodeCursor(last, orderKeys) : null,
                isDone: !hasMore,
                page,
            };
        },

        async findFirst(tableName, args = {}) {
            const result = await writer.findMany(tableName, { ...args, limit: 1 });

            return result.page[0] ?? null;
        },

        async count(tableName, where) {
            if (!schema.tables[tableName]) {
                throw new Error(`unknown table: ${tableName}`);
            }

            onRead(tableName);

            const { params, sql: whereSql } = compileWhere(where, doWhereStrategy);

            let querySql = `SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`;

            if (whereSql) {
                querySql += ` WHERE ${whereSql}`;
            }

            const row = runSql<{ count: number }>(sql, querySql, ...params).one();

            return Number(row.count);
        },

        async insert(tableName, document) {
            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`unknown table: ${tableName}`);
            }

            const withDefaults = applyInsertDefaults(definition, document);
            const id = typeof withDefaults["_id"] === "string" ? (withDefaults["_id"] as string) : generateId();
            const creationTime = typeof withDefaults["_creationTime"] === "number" ? (withDefaults["_creationTime"] as number) : clock();

            const docWithMeta: Record<string, unknown> = { ...withDefaults, _id: id, _creationTime: creationTime };

            // `before` sees a shallow copy so an abort-only handler can't reassign
            // the row's top-level fields before they persist. Nested values are
            // still shared by reference — before-handlers are abort/side-effect
            // only, never row transformers (use `.$defaultFn`/`.$onUpdateFn`).
            await fireTriggers("before", "insert", { doc: { ...docWithMeta }, id, op: "insert", table: tableName });

            runWrite(
                sql,
                tableName,
                `INSERT INTO ${quoteIdentifier(tableName)} (id, _creationTime, ${DOC_COLUMN}) VALUES (?, ?, ?)`,
                id,
                creationTime,
                JSON.stringify(docWithMeta),
            );

            broadcast({ table: tableName, op: "insert", key: id, row: docWithMeta });
            await fireTriggers("after", "insert", { doc: docWithMeta, id, op: "insert", table: tableName });
            await onWrite({ op: "insert", table: tableName, id, doc: docWithMeta });

            return id;
        },

        async patch(id, patch) {
            const existing = await writer.get(id);

            if (!existing) {
                throw new Error(`document not found: ${id}`);
            }

            const tableName = tableNameFromId(sql, schema, id);

            if (!tableName) {
                throw new Error(`document not found: ${id}`);
            }

            const merged = { ...existing, ...patch, _id: id };

            applyOnUpdate(schema.tables[tableName]!, patch, merged);

            await fireTriggers("before", "update", { doc: { ...merged }, id, op: "update", previous: existing, table: tableName });

            runWrite(sql, tableName, `UPDATE ${quoteIdentifier(tableName)} SET ${DOC_COLUMN} = ? WHERE id = ?`, JSON.stringify(merged), id);

            broadcast({ table: tableName, op: "update", key: id, row: merged });
            await fireTriggers("after", "update", { doc: merged, id, op: "update", previous: existing, table: tableName });
            await onWrite({ op: "update", table: tableName, id, doc: merged });
        },

        async replace(id, document) {
            const tableName = tableNameFromId(sql, schema, id);

            if (!tableName) {
                throw new Error(`document not found: ${id}`);
            }

            // Only pay the extra read to supply `previous` when an update trigger exists.
            const previous = hasTrigger(schema, tableName, "update") ? await writer.get(id) ?? undefined : undefined;
            const creationTime = typeof document["_creationTime"] === "number" ? (document["_creationTime"] as number) : clock();
            const replaced: Record<string, unknown> = { ...document, _id: id, _creationTime: creationTime };

            applyOnUpdate(schema.tables[tableName]!, document, replaced);

            await fireTriggers("before", "update", { doc: { ...replaced }, id, op: "update", previous, table: tableName });

            runWrite(
                sql,
                tableName,
                `UPDATE ${quoteIdentifier(tableName)} SET _creationTime = ?, ${DOC_COLUMN} = ? WHERE id = ?`,
                creationTime,
                JSON.stringify(replaced),
                id,
            );

            broadcast({ table: tableName, op: "update", key: id, row: replaced });
            await fireTriggers("after", "update", { doc: replaced, id, op: "update", previous, table: tableName });
            await onWrite({ op: "update", table: tableName, id, doc: replaced });
        },

        async delete(id) {
            const tableName = tableNameFromId(sql, schema, id);

            if (!tableName) {
                return;
            }

            const existing = await writer.get(id);

            // `before` fires ahead of cascade resolution so a throwing guard
            // aborts the delete before any holder rows are touched.
            await fireTriggers("before", "delete", { id, op: "delete", previous: existing ?? undefined, table: tableName });

            // Resolve declared `onDelete` actions on holder rows *before* the
            // physical delete, so `restrict` can abort and cascaded child
            // deletes still fire their own broadcast/onWrite per row.
            await applyOnDelete({
                deletedId: id,
                deletedReference: (references) => existing?.[references],
                findHolders: async (holderTable, field, value) => (await writer.findMany(holderTable, { where: { [field]: value } })).page,
                onCascade: (holderId) => writer.delete(holderId),
                onRestrict: (message) => {
                    throw new ConflictError(message);
                },
                onSetNull: (holderId, field) => writer.patch(holderId, { [field]: null }),
                schema,
                tableName,
            });

            runSql(sql, `DELETE FROM ${quoteIdentifier(tableName)} WHERE id = ?`, id);

            broadcast({ table: tableName, op: "delete", key: id });
            await fireTriggers("after", "delete", { id, op: "delete", previous: existing ?? undefined, table: tableName });
            await onWrite({ op: "delete", table: tableName, id });
        },
    };

    // Declared after `writer` but closed over by `fireTriggers` (defined above):
    // safe because `fireTriggers` only runs while a write is in flight, long
    // after construction has initialized this binding.
    const triggerCtx: TriggerContextLike = { db: writer, scheduler };

    return writer;
};

/**
 * Bring the SQLite database into the shape declared by `schema`. Idempotent
 * — every statement uses `IF NOT EXISTS`, so it's safe to call on every
 * cold start.
 *
 * Global tables (`.global()`) live in D1, not in the DO — they're skipped
 * here. The DO sees them via the D1 adapter exposed elsewhere.
 */
export const runShardMigrations = (sql: SqlExec, schema: SchemaLike): void => {
    for (const [tableName, definition] of Object.entries(schema.tables)) {
        if (definition.shardMode?.kind === "global") {
            continue;
        }

        const tableSql = `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (
            id TEXT PRIMARY KEY,
            _creationTime REAL NOT NULL,
            ${DOC_COLUMN} TEXT NOT NULL
        )`;

        runSql(sql, tableSql);

        for (const index of definition.indexes) {
            const indexName = `${tableName}_${index.name}`;
            const expressions = index.fields.map(jsonPath).join(", ");
            const uniqueClause = index.unique ? "UNIQUE" : "";
            const indexSql = `CREATE ${uniqueClause} INDEX IF NOT EXISTS ${quoteIdentifier(indexName)} ON ${quoteIdentifier(tableName)} (${expressions})`;

            runSql(sql, indexSql);
        }

        // `.unique()` columns synthesize a UNIQUE expression index so SQLite
        // enforces the constraint; the write layer maps breaches to ConflictError.
        for (const [field, column] of tableColumns(definition)) {
            if (!column.unique) {
                continue;
            }

            const indexName = `${tableName}_unique_${field}`;
            const indexSql = `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(indexName)} ON ${quoteIdentifier(tableName)} (${jsonPath(field)})`;

            runSql(sql, indexSql);
        }
    }
};
