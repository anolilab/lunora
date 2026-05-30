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
    AggregateIndexDefinitionLike,
    AggregateOptions,
    AggregateResult,
    ColumnMetaLike,
    DatabaseWriterLike,
    GroupByEntry,
    GroupByOptions,
    RankIndexDefinitionLike,
    RankPage,
    RankResult,
    RestrictableQueryOptions,
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
    CountRlsUnsupportedError,
    decodeCursor,
    encodeCursor,
    encodePartitionKey,
    hasTrigger,
    matchesRankStaticWhere,
    mergeWhere,
    normalizeOrderKeys,
    NotFoundError,
    RANK_TIEBREAK,
    rankTableName,
    resolveRankPartition,
    resolveWith,
    runTriggers,
    selectIndexForAggregate,
    selectIndexForCount,
    selectIndexForGroupBy,
    sortColumnName,
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

/** Companion-table name for an aggregateIndex (`__agg_` infix matches the DO dialect). */
const aggregateTableName = (table: string, indexName: string): string => `${table}__agg_${indexName}`;

/** Canonical-JSON encoding of a `by`-tuple — kept identical to the DO encoding so a parity test can compare bytes. */
const encodeAggregateKey = (by: ReadonlyArray<string>, source: Record<string, unknown>): string => {
    if (by.length === 0) {
        return "";
    }

    const ordered: Record<string, unknown> = {};

    for (const field of [...by].sort()) {
        ordered[field] = source[field] ?? null;
    }

    return JSON.stringify(ordered);
};

/**
 * Cheap predicate test against a flat literal `where` baked into an
 * `aggregateIndex.where`. Mirrors the DO helper.
 */
const matchesStaticWhere = (document: Record<string, unknown>, predicate: Record<string, unknown>): boolean => {
    for (const [field, expected] of Object.entries(predicate)) {
        const actual = document[field];

        if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
            const operatorKeys = Object.keys(expected as Record<string, unknown>);

            if (operatorKeys.length === 1 && operatorKeys[0] === "eq") {
                if (actual !== (expected as { eq: unknown }).eq) {
                    return false;
                }

                continue;
            }

            return false;
        }

        if (actual !== expected) {
            return false;
        }
    }

    return true;
};

/** Marker keys distinguishing `RestrictableQueryOptions` from a `WhereInput`. */
const COUNT_OPTION_KEYS = new Set(["baseWhere", "restrictsCounts", "where"]);

const normalizeCountArg = (arg: RestrictableQueryOptions | undefined | WhereInput): RestrictableQueryOptions => {
    if (arg === undefined) {
        return {};
    }

    if (typeof arg !== "object" || Array.isArray(arg)) {
        return { where: arg as WhereInput };
    }

    const keys = Object.keys(arg as Record<string, unknown>);

    if (keys.length === 0) {
        return {};
    }

    if (keys.every((key) => COUNT_OPTION_KEYS.has(key))) {
        return arg as RestrictableQueryOptions;
    }

    return { where: arg as WhereInput };
};

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

    // Per-(table, index) backfill state. The map records the outcome of the
    // probe: `true` once the counter companion table was found and rebuilt;
    // `false` once we've checked and the user hasn't materialized it, so we
    // know to skip the indexed path on every subsequent read for this ctx-db.
    const backfilled = new Map<string, boolean>();

    /**
     * Whether `table` has a corresponding `__agg_<index>` companion table on
     * the D1 binding. Global tables ship with their own DDL — counter tables
     * are opt-in: if the user hasn't defined one, we silently fall back to a
     * SCAN-based count. The same opt-in shape is what `runD1AggregateMigrations`
     * (the helper exported for tests/dev hosts) uses to materialize it.
     */
    const counterTableExists = async (table: string, indexName: string): Promise<boolean> => {
        const aggTable = aggregateTableName(table, indexName);
        const rows = await exec.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [aggTable]);

        return rows.length > 0;
    };

    /**
     * Rebuild a counter from a full table scan. Cheap to call (cache-guarded);
     * idempotent — TRUNCATE then re-tally so a previously-skewed counter heals.
     */
    const ensureBackfilled = async (tableName: string, index: AggregateIndexDefinitionLike): Promise<boolean> => {
        const cacheKey = `${tableName}::${index.name}`;
        const cached = backfilled.get(cacheKey);

        if (cached !== undefined) {
            return cached;
        }

        const exists = await counterTableExists(tableName, index.name);

        if (!exists) {
            backfilled.set(cacheKey, false);

            return false;
        }

        const definition = schema.tables[tableName]!;
        const rows = await exec.all(`SELECT * FROM ${quoteIdentifier(tableName)}`, []);
        const by = index.by ?? [];
        const tallies = new Map<string, number>();

        for (const row of rows) {
            const doc = decodeRow(definition, row);

            if (!doc) {
                continue;
            }

            if (index.where && !matchesStaticWhere(doc, index.where)) {
                continue;
            }

            const encoded = encodeAggregateKey(by, doc);

            tallies.set(encoded, (tallies.get(encoded) ?? 0) + 1);
        }

        const aggTable = aggregateTableName(tableName, index.name);

        await exec.run(`DELETE FROM ${quoteIdentifier(aggTable)}`, []);

        for (const [encoded, count] of tallies) {
            await exec.run(`INSERT INTO ${quoteIdentifier(aggTable)} ("__key__", "__value__") VALUES (?, ?)`, [encoded, count]);
        }

        backfilled.set(cacheKey, true);

        return true;
    };

    const stepAggregate = async (tableName: string, index: AggregateIndexDefinitionLike, doc: Record<string, unknown>, delta: number): Promise<void> => {
        if (index.where && !matchesStaticWhere(doc, index.where)) {
            return;
        }

        const aggTable = aggregateTableName(tableName, index.name);
        const encoded = encodeAggregateKey(index.by ?? [], doc);

        await exec.run(
            `INSERT INTO ${quoteIdentifier(aggTable)} ("__key__", "__value__") VALUES (?, ?)
             ON CONFLICT("__key__") DO UPDATE SET "__value__" = "__value__" + excluded."__value__"`,
            [encoded, delta],
        );
    };

    /** Pre-write hook: rebuild counters once per ctx-db before the row mutation. */
    const ensureBackfilledForTable = async (tableName: string): Promise<void> => {
        const indexes = schema.tables[tableName]?.aggregateIndexes;

        if (!indexes || indexes.length === 0) {
            return;
        }

        for (const index of indexes) {
            await ensureBackfilled(tableName, index);
        }
    };

    /** Post-write hook: apply `-prev + next` step for every declared counter. */
    const syncAggregates = async (
        tableName: string,
        previous: Record<string, unknown> | undefined,
        next: Record<string, unknown> | undefined,
    ): Promise<void> => {
        const indexes = schema.tables[tableName]?.aggregateIndexes;

        if (!indexes || indexes.length === 0) {
            return;
        }

        for (const index of indexes) {
            // Skip when the user hasn't materialized the counter companion
            // table — the SCAN fallback still answers correctly.
            const exists = await counterTableExists(tableName, index.name);

            if (!exists) {
                continue;
            }

            if (previous) {
                await stepAggregate(tableName, index, previous, -1);
            }

            if (next) {
                await stepAggregate(tableName, index, next, 1);
            }
        }
    };

    // Per-(table, rankIndex) backfill state, same shape as aggregate
    // counters. `true` ⇒ companion exists and has been rebuilt; `false` ⇒
    // companion missing (skip indexed path forever for this ctx-db).
    const rankBackfilled = new Map<string, boolean>();

    const rankTableExists = async (table: string, indexName: string): Promise<boolean> => {
        const rankTable = rankTableName(table, indexName);
        const rows = await exec.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [rankTable]);

        return rows.length > 0;
    };

    /**
     * Lazy backfill of a rank companion. Mirrors the aggregate counter twin —
     * `ensureBackfilled`. TRUNCATE then re-insert; cached per ctx-db.
     */
    const ensureRankBackfilled = async (tableName: string, index: RankIndexDefinitionLike): Promise<boolean> => {
        const cacheKey = `${tableName}::rank::${index.name}`;
        const cached = rankBackfilled.get(cacheKey);

        if (cached !== undefined) {
            return cached;
        }

        const exists = await rankTableExists(tableName, index.name);

        if (!exists) {
            rankBackfilled.set(cacheKey, false);

            return false;
        }

        const definition = schema.tables[tableName]!;
        const rows = await exec.all(`SELECT * FROM ${quoteIdentifier(tableName)}`, []);
        const rankTable = rankTableName(tableName, index.name);

        await exec.run(`DELETE FROM ${quoteIdentifier(rankTable)}`, []);

        const sortColumns = index.sortBy.map((_, i) => sortColumnName(i));
        const columnList = ["__id__", "__partition__", ...sortColumns].map(quoteIdentifier).join(", ");
        const placeholders = ["?", "?", ...sortColumns.map(() => "?")].join(", ");
        const insertSql = `INSERT INTO ${quoteIdentifier(rankTable)} (${columnList}) VALUES (${placeholders})`;

        for (const row of rows) {
            const doc = decodeRow(definition, row);

            if (!doc) {
                continue;
            }

            if (index.where && !matchesRankStaticWhere(doc, index.where)) {
                continue;
            }

            const partitionKey = encodePartitionKey(index.partitionBy ?? [], doc);
            const sortValues = index.sortBy.map((key) => serializeColumnValue(doc[key.field] ?? null));

            await exec.run(insertSql, [doc["_id"] as string, partitionKey, ...sortValues]);
        }

        rankBackfilled.set(cacheKey, true);

        return true;
    };

    /** Pre-write hook: rebuild rank companions once per ctx-db. */
    const ensureRankBackfilledForTable = async (tableName: string): Promise<void> => {
        const indexes = schema.tables[tableName]?.rankIndexes;

        if (!indexes || indexes.length === 0) {
            return;
        }

        for (const index of indexes) {
            await ensureRankBackfilled(tableName, index);
        }
    };

    /**
     * Post-write hook: DELETE+INSERT keeps the companion in lockstep with the
     * source row. Skips silently when the user hasn't materialized the
     * companion (the SCAN-free rank path will be unavailable, but the data
     * remains correct).
     */
    const syncRanks = async (
        tableName: string,
        id: string,
        previous: Record<string, unknown> | undefined,
        next: Record<string, unknown> | undefined,
    ): Promise<void> => {
        const indexes = schema.tables[tableName]?.rankIndexes;

        if (!indexes || indexes.length === 0) {
            return;
        }

        for (const index of indexes) {
            const exists = await rankTableExists(tableName, index.name);

            if (!exists) {
                continue;
            }

            const rankTable = rankTableName(tableName, index.name);

            if (previous) {
                await exec.run(`DELETE FROM ${quoteIdentifier(rankTable)} WHERE "__id__" = ?`, [id]);
            }

            if (next) {
                if (index.where && !matchesRankStaticWhere(next, index.where)) {
                    continue;
                }

                const sortColumns = index.sortBy.map((_, i) => sortColumnName(i));
                const columnList = ["__id__", "__partition__", ...sortColumns].map(quoteIdentifier).join(", ");
                const placeholders = ["?", "?", ...sortColumns.map(() => "?")].join(", ");
                const partitionKey = encodePartitionKey(index.partitionBy ?? [], next);
                const sortValues = index.sortBy.map((key) => serializeColumnValue(next[key.field] ?? null));

                await exec.run(`INSERT INTO ${quoteIdentifier(rankTable)} (${columnList}) VALUES (${placeholders})`, [id, partitionKey, ...sortValues]);
            }
        }
    };

    /**
     * Precomputed `(table → timing → op)` matcher: matches the DO ctx-db
     * fast-path so writer methods can skip the `await fireTriggers(...)`
     * microtask when no trigger is declared for the (timing, op).
     */
    const triggerMatchers = new Set<string>();

    for (const [tableName, definition] of Object.entries(schema.tables)) {
        for (const trigger of Object.values(definition.triggerMap ?? {})) {
            triggerMatchers.add(`${tableName} ${trigger.timing} ${trigger.op}`);
        }
    }

    const hasMatchingTrigger = (tableName: string, timing: TriggerTimingLike, op: TriggerOpLike): boolean =>
        triggerMatchers.has(`${tableName} ${timing} ${op}`);

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
        async count(tableName, whereOrOptions) {
            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`unknown table: ${tableName}`);
            }

            const opts = normalizeCountArg(whereOrOptions);

            if (opts.restrictsCounts) {
                throw new CountRlsUnsupportedError(tableName);
            }

            // Indexed path: same planner as the DO dialect (see ctx-db.ts).
            // We only attempt the counter when no baseWhere is set; otherwise
            // we route uniformly through SQL so the RLS predicate participates.
            if (definition.aggregateIndexes && !opts.baseWhere) {
                const planned = selectIndexForCount(definition.aggregateIndexes, opts.where as Record<string, unknown> | undefined);

                if (planned) {
                    const counterReady = await ensureBackfilled(tableName, planned.index);

                    if (counterReady) {
                        const encoded = encodeAggregateKey(planned.index.by ?? [], planned.key);
                        const aggTable = aggregateTableName(tableName, planned.index.name);
                        const rows = await exec.all(`SELECT "__value__" AS value FROM ${quoteIdentifier(aggTable)} WHERE "__key__" = ?`, [encoded]);

                        return rows.length === 0 ? 0 : Number(rows[0]!["value"] ?? 0);
                    }
                }
            }

            const effective = mergeWhere(opts.baseWhere, opts.where);
            const { params, sql: whereSql } = compileWhere(effective, d1WhereStrategy);

            let querySql = `SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`;

            if (whereSql) {
                querySql += ` WHERE ${whereSql}`;
            }

            const rows = await exec.all(querySql, params);

            return Number(rows[0]?.["count"] ?? 0);
        },

        async aggregate(tableName, aggOptions: AggregateOptions): Promise<AggregateResult> {
            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`unknown table: ${tableName}`);
            }

            if (aggOptions.op === "count") {
                return writer.count(tableName, {
                    baseWhere: aggOptions.baseWhere,
                    restrictsCounts: aggOptions.restrictsCounts,
                    where: aggOptions.where,
                });
            }

            if (!aggOptions.field) {
                throw new Error(`aggregate(${tableName}, { op: "${aggOptions.op}" }): "field" is required for non-count reducers`);
            }

            // Indexed path mirrors @cirrus/do: when no baseWhere is set and
            // an aggregateIndex with matching (op, field, by) covers the
            // request, route to the counter companion — one row read regardless
            // of N. Same scan fallback when baseWhere is present so the RLS
            // predicate participates uniformly.
            if (definition.aggregateIndexes && !aggOptions.baseWhere) {
                const planned = selectIndexForAggregate(
                    definition.aggregateIndexes,
                    aggOptions.op,
                    aggOptions.field,
                    aggOptions.where as Record<string, unknown> | undefined,
                );

                if (planned) {
                    const counterReady = await ensureBackfilled(tableName, planned.index);

                    if (counterReady) {
                        const encoded = encodeAggregateKey(planned.index.by ?? [], planned.key);
                        const aggTable = aggregateTableName(tableName, planned.index.name);
                        const indexedRows = await exec.all(`SELECT "__value__" AS value FROM ${quoteIdentifier(aggTable)} WHERE "__key__" = ?`, [encoded]);

                        if (indexedRows.length === 0) {
                            return null;
                        }

                        const indexedValue = indexedRows[0]?.["value"];

                        return indexedValue === null || indexedValue === undefined ? null : Number(indexedValue);
                    }
                }
            }

            const effective = mergeWhere(aggOptions.baseWhere, aggOptions.where);
            const { params, sql: whereSql } = compileWhere(effective, d1WhereStrategy);

            let querySql = `SELECT ${aggOptions.op.toUpperCase()}(${columnRef(aggOptions.field)}) AS value FROM ${quoteIdentifier(tableName)}`;

            if (whereSql) {
                querySql += ` WHERE ${whereSql}`;
            }

            const rows = await exec.all(querySql, params);
            const value = rows[0]?.["value"];

            return value === null || value === undefined ? null : Number(value);
        },

        async groupBy(tableName, groupOptions: GroupByOptions): Promise<ReadonlyArray<GroupByEntry>> {
            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`unknown table: ${tableName}`);
            }

            const agg = groupOptions.agg ?? { op: "count" };

            if (agg.op !== "count" && !agg.field) {
                throw new Error(`groupBy(${tableName}, { agg: { op: "${agg.op}" } }): "field" is required for non-count reducers`);
            }

            // Indexed path mirrors @cirrus/do: when no baseWhere is set and an
            // aggregateIndex's `by` exactly matches `groupOptions.by` (op +
            // field too, when not `count`), every group answer is already in
            // the companion table. baseWhere falls through to scan.
            if (definition.aggregateIndexes && !groupOptions.baseWhere) {
                const planned = selectIndexForGroupBy(
                    definition.aggregateIndexes,
                    agg.op,
                    agg.field,
                    groupOptions.by,
                    groupOptions.where as Record<string, unknown> | undefined,
                );

                if (planned) {
                    const counterReady = await ensureBackfilled(tableName, planned.index);

                    if (counterReady) {
                        const aggTable = aggregateTableName(tableName, planned.index.name);
                        const partialKeys = Object.keys(planned.partial);
                        const indexedResult: GroupByEntry[] = [];

                        if (partialKeys.length === (planned.index.by ?? []).length && partialKeys.length > 0) {
                            const encoded = encodeAggregateKey(planned.index.by ?? [], planned.partial);
                            const rowsIndexed = await exec.all(`SELECT "__value__" AS value FROM ${quoteIdentifier(aggTable)} WHERE "__key__" = ?`, [encoded]);

                            if (rowsIndexed.length > 0) {
                                const value = rowsIndexed[0]?.["value"];

                                indexedResult.push({
                                    key: { ...planned.partial },
                                    value: value === null || value === undefined ? null : Number(value),
                                });
                            }

                            return indexedResult;
                        }

                        const rowsIndexed = await exec.all(`SELECT "__key__" AS key, "__value__" AS value FROM ${quoteIdentifier(aggTable)}`, []);

                        for (const row of rowsIndexed) {
                            const decoded = JSON.parse(row["key"] as string) as Record<string, unknown>;
                            const { value } = row as { value: unknown };

                            indexedResult.push({ key: decoded, value: value == null ? null : Number(value) });
                        }

                        return indexedResult;
                    }
                }
            }

            const effective = mergeWhere(groupOptions.baseWhere, groupOptions.where);
            const { params, sql: whereSql } = compileWhere(effective, d1WhereStrategy);

            const select = groupOptions.by.map((field) => `${columnRef(field)} AS ${quoteIdentifier(field)}`);

            if (agg.op === "count") {
                select.push(`COUNT(*) AS value`);
            } else {
                select.push(`${agg.op.toUpperCase()}(${columnRef(agg.field!)}) AS value`);
            }

            let querySql = `SELECT ${select.join(", ")} FROM ${quoteIdentifier(tableName)}`;

            if (whereSql) {
                querySql += ` WHERE ${whereSql}`;
            }

            querySql += ` GROUP BY ${groupOptions.by.map(columnRef).join(", ")}`;

            const rows = await exec.all(querySql, params);
            const result: GroupByEntry[] = [];

            for (const row of rows) {
                const key: Record<string, unknown> = {};

                for (const field of groupOptions.by) {
                    key[field] = row[field] ?? null;
                }

                const { value } = row as { value: unknown };

                result.push({ key, value: value === null || value === undefined ? null : Number(value) });
            }

            return result;
        },

        async rank(tableName, indexName, rankOptions): Promise<null | RankResult> {
            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`unknown table: ${tableName}`);
            }

            const index = definition.rankIndexes?.find((i) => i.name === indexName);

            if (!index) {
                throw new Error(`unknown rankIndex "${indexName}" on table "${tableName}"`);
            }

            // Same RLS coupling-seam semantics as count(): position is a
            // count-rows-strictly-before; an RLS-restricted ctx can't return
            // a correct count, so the rank throws the same error.
            if (rankOptions.restrictsCounts) {
                throw new CountRlsUnsupportedError(tableName);
            }

            const counterReady = await ensureRankBackfilled(tableName, index);

            if (!counterReady) {
                // No companion table — caller can't get a rank from D1 in
                // this dialect. Surface as null (the row may exist in the
                // source table but isn't tracked).
                return null;
            }

            const rowId = typeof rankOptions.row === "string" ? rankOptions.row : (rankOptions.row["_id"] as string | undefined);

            if (!rowId) {
                return null;
            }

            const rankTable = rankTableName(tableName, index.name);
            const sortColumns = index.sortBy.map((_, i) => sortColumnName(i));
            const sortColumnList = sortColumns.map(quoteIdentifier).join(", ");
            const ownRows = await exec.all(
                `SELECT "__partition__"${sortColumnList ? `, ${sortColumnList}` : ""} FROM ${quoteIdentifier(rankTable)} WHERE "__id__" = ?`,
                [rowId],
            );

            if (ownRows.length === 0) {
                return null;
            }

            const own = ownRows[0]!;
            let partitionKey = own["__partition__"] as string;

            const effective = mergeWhere(rankOptions.baseWhere, rankOptions.where);
            const partitionFromWhere = resolveRankPartition(index, effective as Record<string, unknown> | undefined);

            if (partitionFromWhere) {
                const requestedKey = encodePartitionKey(index.partitionBy ?? [], partitionFromWhere);

                if (requestedKey !== partitionKey) {
                    return null;
                }

                partitionKey = requestedKey;
            }

            const beforeBranches: string[] = [];
            const beforeParams: unknown[] = [];

            for (let pivot = 0; pivot < sortColumns.length + 1; pivot += 1) {
                const conditions: string[] = [];

                for (let prefix = 0; prefix < pivot; prefix += 1) {
                    conditions.push(`${quoteIdentifier(sortColumns[prefix]!)} IS ?`);
                    beforeParams.push(own[sortColumns[prefix]!] as unknown);
                }

                if (pivot < sortColumns.length) {
                    const column = sortColumns[pivot]!;
                    const { direction } = index.sortBy[pivot]!;
                    const operator = direction === "desc" ? ">" : "<";

                    conditions.push(`${quoteIdentifier(column)} ${operator} ?`);
                    beforeParams.push(own[column] as unknown);
                } else {
                    conditions.push(`${quoteIdentifier(RANK_TIEBREAK)} < ?`);
                    beforeParams.push(rowId);
                }

                beforeBranches.push(conditions.length === 1 ? conditions[0]! : `(${conditions.join(" AND ")})`);
            }

            const beforeRows = await exec.all(
                `SELECT COUNT(*) AS c FROM ${quoteIdentifier(rankTable)} WHERE "__partition__" = ? AND (${beforeBranches.join(" OR ")})`,
                [partitionKey, ...beforeParams],
            );
            const totalRows = await exec.all(`SELECT COUNT(*) AS c FROM ${quoteIdentifier(rankTable)} WHERE "__partition__" = ?`, [partitionKey]);

            return { position: Number(beforeRows[0]?.["c"] ?? 0) + 1, total: Number(totalRows[0]?.["c"] ?? 0) };
        },

        async rankPage(tableName, indexName, rankPageOptions = {}): Promise<RankPage> {
            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`unknown table: ${tableName}`);
            }

            const index = definition.rankIndexes?.find((i) => i.name === indexName);

            if (!index) {
                throw new Error(`unknown rankIndex "${indexName}" on table "${tableName}"`);
            }

            const counterReady = await ensureRankBackfilled(tableName, index);

            if (!counterReady) {
                return { continueCursor: null, isDone: true, page: [] };
            }

            const rankTable = rankTableName(tableName, index.name);
            const sortColumns = index.sortBy.map((_, i) => sortColumnName(i));
            const take = Math.max(1, Math.min(1000, Math.floor(rankPageOptions.take ?? 100)));
            const effective = mergeWhere(rankPageOptions.baseWhere, rankPageOptions.where);
            const partitionFromWhere = resolveRankPartition(index, effective as Record<string, unknown> | undefined);

            const orderClauses: string[] = [`"__partition__" ASC`];

            for (const [i, column] of sortColumns.entries()) {
                orderClauses.push(`${quoteIdentifier(column)} ${index.sortBy[i]!.direction === "desc" ? "DESC" : "ASC"}`);
            }

            orderClauses.push(`${quoteIdentifier(RANK_TIEBREAK)} ASC`);

            const whereClauses: string[] = [];
            const params: unknown[] = [];

            if (partitionFromWhere) {
                whereClauses.push(`"__partition__" = ?`);
                params.push(encodePartitionKey(index.partitionBy ?? [], partitionFromWhere));
            }

            if (rankPageOptions.cursor) {
                const decoded = decodeCursor(rankPageOptions.cursor) as Array<unknown>;
                const expectedLength = 1 + sortColumns.length + 1;

                if (decoded.length === expectedLength) {
                    const cols: Array<{ column: string; direction: "asc" | "desc" }> = [{ column: "__partition__", direction: "asc" }];

                    for (const [i, column] of sortColumns.entries()) {
                        cols.push({ column, direction: index.sortBy[i]!.direction });
                    }

                    cols.push({ column: RANK_TIEBREAK, direction: "asc" });

                    const branches: string[] = [];

                    for (const [pivot, col] of cols.entries()) {
                        const conditions: string[] = [];

                        for (let prefix = 0; prefix < pivot; prefix += 1) {
                            conditions.push(`${quoteIdentifier(cols[prefix]!.column)} IS ?`);
                            params.push(decoded[prefix]);
                        }

                        const operator = col.direction === "desc" ? "<" : ">";

                        conditions.push(`${quoteIdentifier(col.column)} ${operator} ?`);
                        params.push(decoded[pivot]);
                        branches.push(conditions.length === 1 ? conditions[0]! : `(${conditions.join(" AND ")})`);
                    }

                    whereClauses.push(`(${branches.join(" OR ")})`);
                }
            }

            const sortColumnList = sortColumns.map(quoteIdentifier).join(", ");
            const idColumn = quoteIdentifier(RANK_TIEBREAK);
            const partitionColumn = `"__partition__"`;
            const innerWhere = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(" AND ")}` : "";
            const selectColumns = sortColumns.length > 0 ? `${idColumn}, ${partitionColumn}, ${sortColumnList}` : `${idColumn}, ${partitionColumn}`;
            const querySql = `SELECT ${selectColumns} FROM ${quoteIdentifier(rankTable)}${innerWhere} ORDER BY ${orderClauses.join(", ")} LIMIT ${take + 1}`;
            const rankRows = await exec.all(querySql, params);
            const hasMore = rankRows.length > take;
            const usable = hasMore ? rankRows.slice(0, take) : rankRows;

            // Batched hydration: a single `IN (?, ?, …)` per chunk instead of
            // one SELECT per rank row. D1's SQL-parameter ceiling is on the
            // order of 100/query, so we chunk and fan the chunks out via
            // Promise.all. A 100-row page used to issue 101 D1 queries;
            // it now issues ⌈n/IN_CHUNK_SIZE⌉.
            const IN_CHUNK_SIZE = 100;
            const ids = usable.map((rankRow) => rankRow[RANK_TIEBREAK] as string);
            const chunks: string[][] = [];

            for (let cursor = 0; cursor < ids.length; cursor += IN_CHUNK_SIZE) {
                chunks.push(ids.slice(cursor, cursor + IN_CHUNK_SIZE));
            }

            const byId = new Map<string, Record<string, unknown>>();
            const fetched = await Promise.all(
                chunks.map(async (chunk) => {
                    const placeholders = chunk.map(() => "?").join(", ");

                    return exec.all(`SELECT * FROM ${quoteIdentifier(tableName)} WHERE "id" IN (${placeholders})`, chunk);
                }),
            );

            for (const rows of fetched) {
                for (const row of rows) {
                    byId.set(row["id"] as string, row);
                }
            }

            // Restore the rank companion's order (the IN-fetch returns rows
            // in arbitrary order).
            const docs: Array<Record<string, unknown>> = [];

            for (const rankRow of usable) {
                const doc = decodeRow(definition, byId.get(rankRow[RANK_TIEBREAK] as string));

                if (doc) {
                    docs.push(doc);
                }
            }

            let continueCursor: null | string = null;

            if (hasMore) {
                const last = usable.at(-1)!;
                const cursorValues: unknown[] = [last["__partition__"] as unknown];

                for (const column of sortColumns) {
                    cursorValues.push(last[column] as unknown);
                }

                cursorValues.push(last[RANK_TIEBREAK] as unknown);

                const json = JSON.stringify(cursorValues);
                const bytes = new TextEncoder().encode(json);
                let binary = "";

                for (const byte of bytes) {
                    binary += String.fromCharCode(byte);
                }

                continueCursor = btoa(binary);
            }

            return { continueCursor, isDone: !hasMore, page: docs };
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
            if (hasMatchingTrigger(tableName, "before", "delete")) {
                await fireTriggers("before", "delete", { id, op: "delete", previous: existing ?? undefined, table: tableName });
            }

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

            await ensureBackfilledForTable(tableName);
            await ensureRankBackfilledForTable(tableName);

            await runWrite(tableName, `DELETE FROM ${quoteIdentifier(tableName)} WHERE "id" = ?`, [id]);

            await syncAggregates(tableName, existing ?? undefined, undefined);
            await syncRanks(tableName, id, existing ?? undefined, undefined);

            if (hasMatchingTrigger(tableName, "after", "delete")) {
                await fireTriggers("after", "delete", { id, op: "delete", previous: existing ?? undefined, table: tableName });
            }
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

            // RLS (3.2) / aggregates (3.1) inject `baseWhere` we AND-merge
            // before the keyset seek so policy + cursor compose cleanly.
            let predicate: undefined | WhereInput = mergeWhere(args.baseWhere, args.where);

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
            if (hasMatchingTrigger(tableName, "before", "insert")) {
                await fireTriggers("before", "insert", { doc: { ...docWithMeta }, id, op: "insert", table: tableName });
            }

            await ensureBackfilledForTable(tableName);
            await ensureRankBackfilledForTable(tableName);

            const { columns, values } = columnTuple(definition, id, creationTime, withDefaults);
            const placeholders = columns.map(() => "?").join(", ");

            await runWrite(tableName, `INSERT INTO ${quoteIdentifier(tableName)} (${columns.join(", ")}) VALUES (${placeholders})`, values);

            await syncAggregates(tableName, undefined, docWithMeta);
            await syncRanks(tableName, id, undefined, docWithMeta);

            if (hasMatchingTrigger(tableName, "after", "insert")) {
                await fireTriggers("after", "insert", { doc: docWithMeta, id, op: "insert", table: tableName });
            }

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

            if (hasMatchingTrigger(tableName, "before", "update")) {
                await fireTriggers("before", "update", { doc: { ...merged }, id, op: "update", previous: existing, table: tableName });
            }

            await ensureBackfilledForTable(tableName);
            await ensureRankBackfilledForTable(tableName);

            const fields = Object.keys(definition.shape);
            const assignments = fields.map((field) => `${quoteIdentifier(field)} = ?`).join(", ");
            const values = [...fields.map((field) => serializeColumnValue(merged[field] ?? null)), id];

            await runWrite(tableName, `UPDATE ${quoteIdentifier(tableName)} SET ${assignments} WHERE "id" = ?`, values);

            await syncAggregates(tableName, existing, merged);
            await syncRanks(tableName, id, existing, merged);

            if (hasMatchingTrigger(tableName, "after", "update")) {
                await fireTriggers("after", "update", { doc: merged, id, op: "update", previous: existing, table: tableName });
            }
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
            const needsPrevious =
                hasTrigger(schema, tableName, "update") || (definition.aggregateIndexes ?? []).length > 0 || (definition.rankIndexes ?? []).length > 0;
            const previous = needsPrevious ? ((await writer.get(id)) ?? undefined) : undefined;
            const creationTime = typeof document["_creationTime"] === "number" ? (document["_creationTime"] as number) : clock();
            const replaced: Record<string, unknown> = { ...document, _id: id, _creationTime: creationTime };

            applyOnUpdate(definition, document, replaced);

            if (hasMatchingTrigger(tableName, "before", "update")) {
                await fireTriggers("before", "update", { doc: { ...replaced }, id, op: "update", previous, table: tableName });
            }

            await ensureBackfilledForTable(tableName);
            await ensureRankBackfilledForTable(tableName);

            const fields = Object.keys(definition.shape);
            const assignments = ['"_creationTime" = ?', ...fields.map((field) => `${quoteIdentifier(field)} = ?`)].join(", ");
            const values = [creationTime, ...fields.map((field) => serializeColumnValue(replaced[field] ?? null)), id];

            await runWrite(tableName, `UPDATE ${quoteIdentifier(tableName)} SET ${assignments} WHERE "id" = ?`, values);

            await syncAggregates(tableName, previous, replaced);
            await syncRanks(tableName, id, previous, replaced);

            if (hasMatchingTrigger(tableName, "after", "update")) {
                await fireTriggers("after", "update", { doc: replaced, id, op: "update", previous, table: tableName });
            }
        },
    };

    // Declared after `writer` but closed over by `fireTriggers` (defined above):
    // safe because `fireTriggers` only runs while a write is in flight, long
    // after construction has initialized this binding.
    const triggerCtx: TriggerContextLike = { db: writer, scheduler };

    return writer;
};

/**
 * Materialize the `__agg_<index>` companion tables for every declared
 * `aggregateIndex` on a global table. Global tables in Cirrus ship their own
 * DDL — counter tables are opt-in so production hosts can decide where they
 * live. Tests and dev hosts can call this once after their schema migration to
 * unlock O(1) counts.
 *
 * Idempotent (`CREATE TABLE IF NOT EXISTS`).
 */
export const runD1AggregateMigrations = async (exec: D1Exec, schema: SchemaLike): Promise<void> => {
    for (const [tableName, definition] of Object.entries(schema.tables)) {
        const indexes = definition.aggregateIndexes;

        if (!indexes || indexes.length === 0) {
            continue;
        }

        for (const index of indexes) {
            const aggTable = aggregateTableName(tableName, index.name);

            await exec.run(
                `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(aggTable)} (
                    "__key__" TEXT PRIMARY KEY,
                    "__value__" REAL NOT NULL
                )`,
                [],
            );
        }
    }
};

/**
 * Materialize the `__rank_<index>` companion tables for every declared
 * `rankIndex` on a global table. Mirrors `runD1AggregateMigrations` — same
 * opt-in pattern so production hosts decide whether to spend the DDL.
 *
 * Idempotent (`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`).
 */
export const runD1RankMigrations = async (exec: D1Exec, schema: SchemaLike): Promise<void> => {
    for (const [tableName, definition] of Object.entries(schema.tables)) {
        const indexes = definition.rankIndexes;

        if (!indexes || indexes.length === 0) {
            continue;
        }

        for (const index of indexes) {
            const rankTable = rankTableName(tableName, index.name);
            const sortColumns = index.sortBy.map((_, i) => sortColumnName(i));
            const columnDdl = sortColumns.map((column) => `${quoteIdentifier(column)} BLOB`).join(", ");
            const columnPart = sortColumns.length > 0 ? `, ${columnDdl}` : "";

            await exec.run(
                `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(rankTable)} (
                    "__id__" TEXT PRIMARY KEY,
                    "__partition__" TEXT NOT NULL${columnPart}
                )`,
                [],
            );

            const orderedColumns = ['"__partition__" ASC'];

            for (const [i, column] of sortColumns.entries()) {
                orderedColumns.push(`${quoteIdentifier(column)} ${index.sortBy[i]!.direction === "desc" ? "DESC" : "ASC"}`);
            }

            orderedColumns.push('"__id__" ASC');

            const btreeName = `${tableName}__rank_${index.name}__btree`;

            await exec.run(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(btreeName)} ON ${quoteIdentifier(rankTable)} (${orderedColumns.join(", ")})`, []);
        }
    }
};
