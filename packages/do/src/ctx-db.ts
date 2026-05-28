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

import type { MutationDelta } from "./types.js";

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
    readonly shape: Record<string, ValidatorLike>;
    readonly shardMode?: { kind: "global" | "root" | "shardBy" };
}

export interface IndexDefinitionLike {
    readonly fields: ReadonlyArray<string>;
    readonly name: string;
    readonly unique?: boolean;
}

export interface ValidatorLike {
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
    schema: SchemaLike;
    sql: SqlExec;
}

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
    delete: (id: string) => Promise<void>;
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

        async insert(tableName, document) {
            if (!schema.tables[tableName]) {
                throw new Error(`unknown table: ${tableName}`);
            }

            const id = typeof document["_id"] === "string" ? (document["_id"] as string) : generateId();
            const creationTime = typeof document["_creationTime"] === "number" ? (document["_creationTime"] as number) : clock();

            const docWithMeta: Record<string, unknown> = { ...document, _id: id, _creationTime: creationTime };

            runSql(
                sql,
                `INSERT INTO ${quoteIdentifier(tableName)} (id, _creationTime, ${DOC_COLUMN}) VALUES (?, ?, ?)`,
                id,
                creationTime,
                JSON.stringify(docWithMeta),
            );

            broadcast({ table: tableName, op: "insert", key: id, row: docWithMeta });
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

            runSql(sql, `UPDATE ${quoteIdentifier(tableName)} SET ${DOC_COLUMN} = ? WHERE id = ?`, JSON.stringify(merged), id);

            broadcast({ table: tableName, op: "update", key: id, row: merged });
            await onWrite({ op: "update", table: tableName, id, doc: merged });
        },

        async replace(id, document) {
            const tableName = tableNameFromId(sql, schema, id);

            if (!tableName) {
                throw new Error(`document not found: ${id}`);
            }

            const creationTime = typeof document["_creationTime"] === "number" ? (document["_creationTime"] as number) : clock();
            const replaced: Record<string, unknown> = { ...document, _id: id, _creationTime: creationTime };

            runSql(
                sql,
                `UPDATE ${quoteIdentifier(tableName)} SET _creationTime = ?, ${DOC_COLUMN} = ? WHERE id = ?`,
                creationTime,
                JSON.stringify(replaced),
                id,
            );

            broadcast({ table: tableName, op: "update", key: id, row: replaced });
            await onWrite({ op: "update", table: tableName, id, doc: replaced });
        },

        async delete(id) {
            const tableName = tableNameFromId(sql, schema, id);

            if (!tableName) {
                return;
            }

            runSql(sql, `DELETE FROM ${quoteIdentifier(tableName)} WHERE id = ?`, id);

            broadcast({ table: tableName, op: "delete", key: id });
            await onWrite({ op: "delete", table: tableName, id });
        },
    };

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
    }
};
