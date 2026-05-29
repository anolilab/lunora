/**
 * D1 column-dialect twin of the DO `createShardCtxDb` (`@cirrus/do`).
 *
 * Global (`.global()`) tables live in D1 with a real column-per-field physical
 * schema — not the DO's JSON blob — so `where`/`orderBy`/keyset-cursor refer to
 * actual columns (`"field"`) rather than `json_extract(...)`. The query and
 * cursor logic is identical to the DO path: it reuses the shared, dialect-
 * agnostic compiler (`compileWhere`), order-by builder, and keyset helpers from
 * `@cirrus/do`, swapping only the {@link WhereCompilerStrategy} (column refs +
 * value serialization) so the generated `ctx.db.<table>` facade (1.2.7) is
 * backend-agnostic.
 */
import type {
    ColumnMetaLike,
    DatabaseWriterLike,
    SchedulerLike,
    SchemaLike,
    TableDefinitionLike,
    TriggerContextLike,
    TriggerEventLike,
    TriggerOpLike,
    TriggerTimingLike,
    WhereCompilerStrategy,
    WhereInput,
} from "@cirrus/do";
import {
    applyOnDelete,
    buildSeekWhere,
    compileOrderBy,
    compileWhere,
    ConflictError,
    decodeCursor,
    encodeCursor,
    hasTrigger,
    normalizeOrderKeys,
    NotFoundError,
    resolveWith,
    runTriggers,
} from "@cirrus/do";

/**
 * Async SQL surface the D1 ORM needs: `all` for reads, `run` for writes.
 * Satisfied by a `D1Session`/`D1Client` in production and a `node:sqlite`
 * adapter in tests, so the query logic runs against a real SQLite engine.
 */
export interface D1Exec {
    all: (sql: string, parameters: readonly unknown[]) => Promise<Array<Record<string, unknown>>>;
    run: (sql: string, parameters: readonly unknown[]) => Promise<void>;
}

export interface D1CtxDbOptions {
    clock?: () => number;
    exec: D1Exec;
    idGenerator?: () => string;
    /**
     * Scheduler exposed to global-table trigger handlers as `ctx.scheduler`.
     * Absent it, `ctx.scheduler` is a stub that throws on use — pass one when
     * triggers on `.global()` tables need to enqueue follow-up work.
     */
    scheduler?: SchedulerLike;
    schema: SchemaLike;
}

/** Cap on re-entrant trigger writes before we treat it as a self-triggering loop. */
const MAX_TRIGGER_DEPTH = 50;

/** Default `ctx.scheduler` when none is configured: any use throws a clear error. */
const throwingScheduler: SchedulerLike = {
    runAfter: () => {
        throw new Error("ctx.scheduler: no scheduler configured for triggers. Pass `scheduler` to createD1CtxDb().");
    },
    runAt: () => {
        throw new Error("ctx.scheduler: no scheduler configured for triggers. Pass `scheduler` to createD1CtxDb().");
    },
};

const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/**
 * D1 column dialect: a field resolves to its own SQLite column. `_id`/`id`
 * both map to the physical `id` column; `_creationTime` to its own column.
 */
const columnRef = (field: string): string => {
    if (field === "_id" || field === "id") {
        return quoteIdentifier("id");
    }

    if (field === "_creationTime") {
        return quoteIdentifier("_creationTime");
    }

    return quoteIdentifier(field);
};

/** Map a JS value onto its SQLite storage form — SQLite has no boolean, so true/false → 1/0. */
const serializeColumnValue = (value: unknown): unknown => {
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

/** D1 dialect: fields resolve to real columns; values via {@link serializeColumnValue}. */
const d1WhereStrategy: WhereCompilerStrategy = { fieldRef: columnRef, serialize: serializeColumnValue };

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

/** Decode a SELECTed row back into a document: `id` → `_id`, and 1/0 → boolean for boolean columns. */
const decodeRow = (definition: TableDefinitionLike, row: Record<string, unknown> | undefined): Record<string, unknown> | null => {
    if (!row) {
        return null;
    }

    const doc: Record<string, unknown> = {};

    for (const [field, validator] of Object.entries(definition.shape)) {
        const raw = row[field];

        if (raw === undefined) {
            continue;
        }

        doc[field] = validator.kind === "boolean" && (raw === 0 || raw === 1) ? raw === 1 : raw;
    }

    doc["_id"] = row["id"];
    doc["_creationTime"] = row["_creationTime"];

    return doc;
};

/**
 * Fill any field absent from `document` that declares a `.default()` literal or
 * `.$defaultFn()` factory. The factory wins when both are present; a literal is
 * applied on presence so `null`/`false`/`0` defaults survive.
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

/** Recompute every `.$onUpdateFn()` field the caller did not set explicitly, mutating `target` in place. */
const applyOnUpdate = (definition: TableDefinitionLike, provided: Record<string, unknown>, target: Record<string, unknown>): void => {
    for (const [field, column] of tableColumns(definition)) {
        if (column.onUpdateFn && !(field in provided)) {
            target[field] = column.onUpdateFn();
        }
    }
};

/** workerd and node:sqlite both phrase a UNIQUE-index breach as "UNIQUE constraint failed". */
const isUniqueViolation = (error: unknown): boolean => error instanceof Error && /unique constraint failed/i.test(error.message);

/**
 * Probe each table for `id`, mirroring the DO's id-only `get`/`patch`/`delete`
 * resolution. The schema handed in is the global-table subset, so this is a
 * small fixed scan.
 */
const tableNameFromId = async (exec: D1Exec, schema: SchemaLike, id: string): Promise<string | undefined> => {
    for (const tableName of Object.keys(schema.tables)) {
        const rows = await exec.all(`SELECT 1 FROM ${quoteIdentifier(tableName)} WHERE "id" = ? LIMIT 1`, [id]);

        if (rows.length > 0) {
            return tableName;
        }
    }

    return undefined;
};

export const createD1CtxDb = (options: D1CtxDbOptions): DatabaseWriterLike => {
    const { exec, schema } = options;
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

    /** Run a write, remapping a UNIQUE-index breach to a {@link ConflictError} (code `CONFLICT`, 409). */
    const runWrite = async (table: string, sql: string, parameters: readonly unknown[]): Promise<void> => {
        try {
            await exec.run(sql, parameters);
        } catch (error) {
            if (isUniqueViolation(error)) {
                throw new ConflictError(`unique constraint violation on "${table}"`);
            }

            throw error;
        }
    };

    /** Serialize a document into the ordered `[id, _creationTime, ...fields]` column tuple. */
    const columnTuple = (
        definition: TableDefinitionLike,
        id: string,
        creationTime: number,
        doc: Record<string, unknown>,
    ): { columns: string[]; values: unknown[] } => {
        const fields = Object.keys(definition.shape);

        return {
            columns: ["id", "_creationTime", ...fields].map(quoteIdentifier),
            values: [id, creationTime, ...fields.map((field) => serializeColumnValue(doc[field] ?? null))],
        };
    };

    const writer: DatabaseWriterLike = {
        async count(tableName, where) {
            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`unknown table: ${tableName}`);
            }

            const { params, sql: whereSql } = compileWhere(where, d1WhereStrategy);

            let querySql = `SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`;

            if (whereSql) {
                querySql += ` WHERE ${whereSql}`;
            }

            const rows = await exec.all(querySql, params);

            return Number(rows[0]?.["count"] ?? 0);
        },

        async delete(id) {
            const tableName = await tableNameFromId(exec, schema, id);

            if (!tableName) {
                return;
            }

            // Apply declared `onDelete` actions to holder rows before the
            // physical delete, mirroring the DO path.
            const existing = await writer.get(id);

            // `before` fires ahead of cascade resolution so a throwing guard
            // aborts the delete before any holder rows are touched.
            await fireTriggers("before", "delete", { id, op: "delete", previous: existing ?? undefined, table: tableName });

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

            await runWrite(tableName, `DELETE FROM ${quoteIdentifier(tableName)} WHERE "id" = ?`, [id]);

            await fireTriggers("after", "delete", { id, op: "delete", previous: existing ?? undefined, table: tableName });
        },

        async findFirst(tableName, args = {}) {
            const result = await writer.findMany(tableName, { ...args, limit: 1 });

            return result.page[0] ?? null;
        },

        async findFirstOrThrow(tableName, args = {}) {
            const document = await writer.findFirst(tableName, args);

            if (document === null) {
                throw new NotFoundError(`findFirstOrThrow: no "${tableName}" document matched`);
            }

            return document;
        },

        async findMany(tableName, args = {}) {
            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`unknown table: ${tableName}`);
            }

            const orderKeys = normalizeOrderKeys(args.orderBy);
            const seek = args.cursor ? buildSeekWhere(orderKeys, decodeCursor(args.cursor)) : undefined;

            let predicate: undefined | WhereInput = args.where;

            if (seek) {
                predicate = predicate ? { AND: [predicate, seek] } : seek;
            }

            const { params, sql: whereSql } = compileWhere(predicate, d1WhereStrategy);

            let querySql = `SELECT * FROM ${quoteIdentifier(tableName)}`;

            if (whereSql) {
                querySql += ` WHERE ${whereSql}`;
            }

            querySql += ` ORDER BY ${compileOrderBy(orderKeys, columnRef)}`;

            const limit = typeof args.limit === "number" ? Math.max(0, Math.floor(args.limit)) : undefined;

            if (limit !== undefined) {
                // Over-fetch by one row to learn whether another page exists.
                querySql += ` LIMIT ${limit + 1}`;
            }

            const rows = await exec.all(querySql, params);
            const docs: Array<Record<string, unknown>> = [];

            for (const row of rows) {
                const doc = decodeRow(definition, row);

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

        async get(id) {
            const tableName = await tableNameFromId(exec, schema, id);

            if (!tableName) {
                return null;
            }

            const rows = await exec.all(`SELECT * FROM ${quoteIdentifier(tableName)} WHERE "id" = ?`, [id]);

            return decodeRow(schema.tables[tableName]!, rows[0]);
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

            const { columns, values } = columnTuple(definition, id, creationTime, withDefaults);
            const placeholders = columns.map(() => "?").join(", ");

            await runWrite(tableName, `INSERT INTO ${quoteIdentifier(tableName)} (${columns.join(", ")}) VALUES (${placeholders})`, values);

            await fireTriggers("after", "insert", { doc: docWithMeta, id, op: "insert", table: tableName });

            return id;
        },

        async patch(id, patch) {
            const tableName = await tableNameFromId(exec, schema, id);

            if (!tableName) {
                throw new Error(`document not found: ${id}`);
            }

            const definition = schema.tables[tableName]!;
            const existing = await writer.get(id);

            if (!existing) {
                throw new Error(`document not found: ${id}`);
            }

            const merged: Record<string, unknown> = { ...existing, ...patch, _id: id };

            applyOnUpdate(definition, patch, merged);

            await fireTriggers("before", "update", { doc: { ...merged }, id, op: "update", previous: existing, table: tableName });

            const fields = Object.keys(definition.shape);
            const assignments = fields.map((field) => `${quoteIdentifier(field)} = ?`).join(", ");
            const values = [...fields.map((field) => serializeColumnValue(merged[field] ?? null)), id];

            await runWrite(tableName, `UPDATE ${quoteIdentifier(tableName)} SET ${assignments} WHERE "id" = ?`, values);

            await fireTriggers("after", "update", { doc: merged, id, op: "update", previous: existing, table: tableName });
        },

        query() {
            throw new Error("the legacy query()/withIndex() reader is not available on the D1 (global) backend; use findMany");
        },

        async replace(id, document) {
            const tableName = await tableNameFromId(exec, schema, id);

            if (!tableName) {
                throw new Error(`document not found: ${id}`);
            }

            const definition = schema.tables[tableName]!;
            // Only pay the extra read to supply `previous` when an update trigger exists.
            const previous = hasTrigger(schema, tableName, "update") ? await writer.get(id) ?? undefined : undefined;
            const creationTime = typeof document["_creationTime"] === "number" ? (document["_creationTime"] as number) : clock();
            const replaced: Record<string, unknown> = { ...document, _id: id, _creationTime: creationTime };

            applyOnUpdate(definition, document, replaced);

            await fireTriggers("before", "update", { doc: { ...replaced }, id, op: "update", previous, table: tableName });

            const fields = Object.keys(definition.shape);
            const assignments = ['"_creationTime" = ?', ...fields.map((field) => `${quoteIdentifier(field)} = ?`)].join(", ");
            const values = [creationTime, ...fields.map((field) => serializeColumnValue(replaced[field] ?? null)), id];

            await runWrite(tableName, `UPDATE ${quoteIdentifier(tableName)} SET ${assignments} WHERE "id" = ?`, values);

            await fireTriggers("after", "update", { doc: replaced, id, op: "update", previous, table: tableName });
        },
    };

    // Declared after `writer` but closed over by `fireTriggers` (defined above):
    // safe because `fireTriggers` only runs while a write is in flight, long
    // after construction has initialized this binding.
    const triggerCtx: TriggerContextLike = { db: writer, scheduler };

    return writer;
};
