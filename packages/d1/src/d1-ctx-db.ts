/**
 * D1 column-dialect twin of the DO `createShardCtxDb` (`@cirrus/do`).
 *
 * Global (`.global()`) tables live in D1 with a real column-per-field physical
 * schema — not the DO's JSON blob — so `where`/`orderBy`/keyset-cursor refer to
 * actual columns (`"field"`) rather than `json_extract(...)`. The query and
 * cursor logic is identical to the DO path: it reuses the shared, dialect-
 * agnostic compiler (`compileWhere`), order-by builder, and keyset helpers from
 * `@cirrus/do`, swapping only the {@link WhereCompilerStrategy} (column refs +
 * value serialization) so the generated `ctx.db.&lt;table>` facade (1.2.7) is
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
    runRowValidators,
    runTriggers,
    selectIndexForCount,
    selectIndexForGroupBy,
    sortColumnName,
} from "@cirrus/do";

/**
 * Async SQL surface the D1 ORM needs: `all` for reads, `run` for writes.
 * Satisfied by a `D1Session`/`D1Client` in production and a `node:sqlite`
 * adapter in tests, so the query logic runs against a real SQLite engine.
 */
interface D1Exec {
    all: (sql: string, parameters: ReadonlyArray<unknown>) => Promise<Record<string, unknown>[]>;
    run: (sql: string, parameters: ReadonlyArray<unknown>) => Promise<void>;
}

interface D1CtxDbOptions {
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
 * Closed allowlist mapping each reducer `op` to the literal SQL function it may
 * emit. `AggregateOp` is a compile-time type only — a caller reaching the
 * runtime with an off-list `op` (forged wire payload, `as any`) would otherwise
 * have it concatenated straight into the SQL string. Routing every reducer
 * through this table guarantees only a known function name reaches the query.
 */
const AGGREGATE_SQL_FUNCTION: Record<string, string> = { avg: "AVG", count: "COUNT", max: "MAX", min: "MIN", sum: "SUM" };

/** Resolve a reducer `op` to its SQL function, throwing on an off-allowlist op. */
const aggregateSqlFunction = (op: string): string => {
    const fn = AGGREGATE_SQL_FUNCTION[op];

    if (fn === undefined) {
        throw new Error(`unknown aggregate op "${op}": expected one of ${Object.keys(AGGREGATE_SQL_FUNCTION).join(", ")}`);
    }

    return fn;
};

/** Companion-table name for an aggregateIndex (`__agg_` infix matches the DO dialect). */
const aggregateTableName = (table: string, indexName: string): string => `${table}__agg_${indexName}`;

/** Canonical-JSON encoding of a `by`-tuple — kept identical to the DO encoding so a parity test can compare bytes. */
const encodeAggregateKey = (by: ReadonlyArray<string>, source: Record<string, unknown>): string => {
    if (by.length === 0) {
        return "";
    }

    const ordered: Record<string, unknown> = {};

    // Code-unit ordering (identical to a default `Array#sort()`), kept byte-for-
    // byte compatible with the DO encoding so a parity test can compare output.
    const sortedBy = [...by].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    for (const field of sortedBy) {
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
            const operatorKeys = Object.keys(expected);

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

    const keys = Object.keys(arg);

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
const tableColumns = (definition: TableDefinitionLike): [string, ColumnMetaLike][] => {
    const columns: [string, ColumnMetaLike][] = [];

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
            // Deliberate in-place mutation: callers pass the row they want
            // updated (e.g. `merged`/`replaced`) so the recomputed onUpdate
            // values land on the object that is about to be persisted.
            // eslint-disable-next-line no-param-reassign -- documented mutate-in-place contract (see jsdoc above)
            target[field] = column.onUpdateFn();
        }
    }
};

/** Both workerd and node:sqlite phrase a UNIQUE-index breach as "UNIQUE constraint failed". Hoisted to avoid per-call recompilation. */
const UNIQUE_VIOLATION_RE = /unique constraint failed/i;

/** Both workerd and node:sqlite phrase a UNIQUE-index breach as "UNIQUE constraint failed". */
const isUniqueViolation = (error: unknown): boolean => error instanceof Error && UNIQUE_VIOLATION_RE.test(error.message);

/**
 * Capacity of the per-ctx-db `id → tableName` LRU. Bounded so a long-lived ctx
 * (the writer outlives a single request) doesn't accumulate unbounded entries.
 */
const TABLE_NAME_CACHE_CAPACITY = 128;

/**
 * LRU cache over `id → tableName` resolutions. Backed by a `Map` whose insertion
 * order is the LRU order: on hit we delete-then-reinsert to move the key to the
 * tail; on overflow we evict the head (the oldest entry). Per-instance so a new
 * ctx-db starts cold and a unit test never inherits another's cache.
 */
const createTableNameCache = (): {
    delete: (id: string) => void;
    get: (id: string) => string | undefined;
    set: (id: string, table: string) => void;
} => {
    const map = new Map<string, string>();

    return {
        delete: (id) => {
            map.delete(id);
        },
        get: (id) => {
            const hit = map.get(id);

            if (hit === undefined) {
                return undefined;
            }

            // Move to tail (most-recently-used) by re-inserting.
            map.delete(id);
            map.set(id, hit);

            return hit;
        },
        set: (id, table) => {
            if (map.has(id)) {
                map.delete(id);
            } else if (map.size >= TABLE_NAME_CACHE_CAPACITY) {
                const oldest = map.keys().next().value;

                if (oldest !== undefined) {
                    map.delete(oldest);
                }
            }

            map.set(id, table);
        },
    };
};

/**
 * Probe each table for `id`, mirroring the DO's id-only `get`/`patch`/`delete`
 * resolution. The schema handed in is the global-table subset, so this is a
 * small fixed scan — we fan the probes out in parallel and return on the first
 * hit. A small LRU caches successful lookups so a hot id (e.g. the same row
 * updated repeatedly within a request) avoids the fan-out on every call.
 */
const tableNameFromId = async (exec: D1Exec, schema: SchemaLike, id: string, cache: ReturnType<typeof createTableNameCache>): Promise<string | undefined> => {
    const cached = cache.get(id);

    if (cached !== undefined) {
        return cached;
    }

    const candidates: string[] = [];

    for (const [tableName, definition] of Object.entries(schema.tables)) {
        // Skip tables that don't live in D1 — `.shardBy()` is spread across
        // many DOs and would never have a D1 row to find. The default root
        // mode is also DO-side; we only need to probe `.global()` tables.
        // (Schemas authored before the `.global()` flag existed don't set
        // shardMode at all — preserve the legacy "probe every table" behaviour
        // there so existing fixtures keep working.)
        if (definition.shardMode !== undefined && definition.shardMode.kind !== "global") {
            continue;
        }

        candidates.push(tableName);
    }

    // Fire every probe at once; the first non-empty result wins.
    const probes = await Promise.all(
        candidates.map(async (tableName) => {
            const rows = await exec.all(`SELECT 1 FROM ${quoteIdentifier(tableName)} WHERE "id" = ? LIMIT 1`, [id]);

            return { found: rows.length > 0, tableName };
        }),
    );

    for (const result of probes) {
        if (result.found) {
            cache.set(id, result.tableName);

            return result.tableName;
        }
    }

    return undefined;
};

const createD1CtxDb = (options: D1CtxDbOptions): DatabaseWriterLike => {
    const { exec, schema } = options;
    const clock = options.clock ?? (() => Date.now());
    const generateId = options.idGenerator ?? (() => crypto.randomUUID());
    const scheduler = options.scheduler ?? throwingScheduler;

    // Per-ctx-db LRU bounding the `id → tableName` resolution cost. See
    // {@link createTableNameCache} for the size cap rationale.
    const tableNameCache = createTableNameCache();

    let triggerDepth = 0;

    // Per-(table, index) backfill state. The map records the outcome of the
    // probe: `true` once the counter companion table was found and rebuilt;
    // `false` once we've checked and the user hasn't materialized it, so we
    // know to skip the indexed path on every subsequent read for this ctx-db.
    const backfilled = new Map<string, boolean>();

    /**
     * Whether `table` has a corresponding `__agg_&lt;index>` companion table on
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
     * Rebuild a counter from a paged table scan. Cheap to call (cache-guarded);
     * idempotent — TRUNCATE then re-tally so a previously-skewed counter heals.
     * Pages via a keyset cursor on `id` (the table's primary key) with a fixed
     * batch size, so a large global table never has to fit in a single result
     * buffer.
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

        const definition = schema.tables[tableName];

        if (!definition) {
            backfilled.set(cacheKey, false);

            return false;
        }

        const by = index.by ?? [];
        const tallies = new Map<string, number>();
        const BATCH_SIZE = 500;
        let cursorId: string | undefined;

        // Keyset pagination on `id` — page by the last row's id rather than
        // buffering the entire table. Tallies accumulate incrementally so the
        // memory footprint is `unique(by) ` keys, not row count.
        while (true) {
            const pageRows =
                cursorId === undefined
                    ? await exec.all(`SELECT * FROM ${quoteIdentifier(tableName)} ORDER BY "id" ASC LIMIT ?`, [BATCH_SIZE])
                    : await exec.all(`SELECT * FROM ${quoteIdentifier(tableName)} WHERE "id" > ? ORDER BY "id" ASC LIMIT ?`, [cursorId, BATCH_SIZE]);

            if (pageRows.length === 0) {
                break;
            }

            for (const row of pageRows) {
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

            cursorId = pageRows.at(-1)?.["id"] as string | undefined;

            if (pageRows.length < BATCH_SIZE) {
                break;
            }
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
     * `ensureBackfilled`. TRUNCATE then re-insert; cached per ctx-db. Pages
     * the source table via keyset cursor on `id` so an unbounded table never
     * has to fit in a single SELECT.
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

        const definition = schema.tables[tableName];

        if (!definition) {
            rankBackfilled.set(cacheKey, false);

            return false;
        }

        const rankTable = rankTableName(tableName, index.name);

        await exec.run(`DELETE FROM ${quoteIdentifier(rankTable)}`, []);

        const sortColumns = index.sortBy.map((_, i) => sortColumnName(i));
        const columnList = ["__id__", "__partition__", ...sortColumns].map((column) => quoteIdentifier(column)).join(", ");
        const placeholders = ["?", "?", ...sortColumns.map(() => "?")].join(", ");
        const insertSql = `INSERT INTO ${quoteIdentifier(rankTable)} (${columnList}) VALUES (${placeholders})`;

        const BATCH_SIZE = 500;
        let cursorId: string | undefined;

        while (true) {
            const pageRows =
                cursorId === undefined
                    ? await exec.all(`SELECT * FROM ${quoteIdentifier(tableName)} ORDER BY "id" ASC LIMIT ?`, [BATCH_SIZE])
                    : await exec.all(`SELECT * FROM ${quoteIdentifier(tableName)} WHERE "id" > ? ORDER BY "id" ASC LIMIT ?`, [cursorId, BATCH_SIZE]);

            if (pageRows.length === 0) {
                break;
            }

            for (const row of pageRows) {
                const doc = decodeRow(definition, row);

                if (!doc) {
                    continue;
                }

                if (index.where && !matchesRankStaticWhere(doc, index.where)) {
                    continue;
                }

                const partitionKey = encodePartitionKey(index.partitionBy ?? [], doc);
                const sortValues = index.sortBy.map((key) => serializeColumnValue(doc[key.field] ?? null));

                await exec.run(insertSql, [doc["_id"], partitionKey, ...sortValues]);
            }

            cursorId = pageRows.at(-1)?.["id"] as string | undefined;

            if (pageRows.length < BATCH_SIZE) {
                break;
            }
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
                const columnList = ["__id__", "__partition__", ...sortColumns].map((column) => quoteIdentifier(column)).join(", ");
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

    // Forward-declared here so `fireTriggers` (defined below) can close over it;
    // assigned only after `writer` is built. It is read solely while a write is
    // in flight — long after construction finishes — so the binding is always
    // initialized by the time a trigger fires.
    let triggerCtx: TriggerContextLike;

    /** Fire matching triggers with a depth guard against runaway self-triggering. */
    const fireTriggers = async (timing: TriggerTimingLike, op: TriggerOpLike, event: TriggerEventLike): Promise<void> => {
        triggerDepth += 1;

        if (triggerDepth > MAX_TRIGGER_DEPTH) {
            triggerDepth -= 1;

            throw new ConflictError(`trigger recursion exceeded ${String(MAX_TRIGGER_DEPTH)} levels on "${event.table}" — check for a self-triggering write`);
        }

        try {
            // `triggerCtx` is declared after `writer` (further below) but is only
            // read here, while a write is in flight — long after construction has
            // initialized the binding. Referencing it lazily keeps `fireTriggers`
            // defined before `writer` without a forward use-before-define.
            await runTriggers({ ctx: triggerCtx, event, op, schema, tableName: event.table, timing });
        } finally {
            triggerDepth -= 1;
        }
    };

    /**
     * Run a write, remapping a UNIQUE-index breach to a {@link ConflictError}
     * (code `CONFLICT`, 409).
     */
    const runWrite = async (table: string, sql: string, parameters: ReadonlyArray<unknown>): Promise<void> => {
        try {
            await exec.run(sql, parameters);
        } catch (error) {
            if (isUniqueViolation(error)) {
                throw new ConflictError(`unique constraint violation on "${table}"`);
            }

            throw error;
        }
    };

    /**
     * Snapshot the RAW stored row (physical column values, not decoded into a
     * document) for `id` in `tableName`. Captured BEFORE a write's before-
     * trigger / onDelete-cascade `await` window so the optimistic-concurrency
     * CAS can compare stored-value to stored-value. Returns `undefined` when the
     * row is gone.
     */
    const rawRow = async (tableName: string, id: string): Promise<Record<string, unknown> | undefined> => {
        const rows = await exec.all(`SELECT * FROM ${quoteIdentifier(tableName)} WHERE "id" = ?`, [id]);

        return rows[0];
    };

    /**
     * Run an optimistic-concurrency-guarded write — the D1 twin of the DO
     * dialect's `runGuardedWrite`. D1 stores rows as real columns (no `__doc__`
     * blob) and `D1Exec.run` returns no rows-affected count, so the CAS is
     * expressed as `WHERE "id" IS ? AND "&lt;col>" IS ? ... RETURNING "id"` run via
     * `exec.all` (both D1 and node:sqlite support `RETURNING`). The bound values
     * are the RAW column values captured at read time ({@link rawRow}) so the
     * comparison is faithful; `IS` gives NULL-safe equality. An empty RETURNING
     * set means a concurrent write committed during the intervening `await` and
     * changed the row — surfaced as a {@link ConflictError}.
     *
     * `snapshot` of `undefined` means there was nothing on disk at read time
     * (only happens on the delete path when the row was already gone); the
     * guard is skipped because there is no write to perform.
     */
    const runGuardedWrite = async (
        table: string,
        verb: "DELETE" | "UPDATE",
        setClause: string,
        setValues: ReadonlyArray<unknown>,
        snapshot: Record<string, unknown> | undefined,
    ): Promise<void> => {
        if (snapshot === undefined) {
            return;
        }

        const guardColumns = Object.keys(snapshot);
        const guardClause = guardColumns.map((column) => `${quoteIdentifier(column)} IS ?`).join(" AND ");
        const guardValues = guardColumns.map((column) => snapshot[column]);

        const sql =
            verb === "UPDATE"
                ? `UPDATE ${quoteIdentifier(table)} SET ${setClause} WHERE ${guardClause} RETURNING "id"`
                : `DELETE FROM ${quoteIdentifier(table)} WHERE ${guardClause} RETURNING "id"`;

        const parameters = verb === "UPDATE" ? [...setValues, ...guardValues] : guardValues;

        let returned: Record<string, unknown>[];

        try {
            returned = await exec.all(sql, parameters);
        } catch (error) {
            if (isUniqueViolation(error)) {
                throw new ConflictError(`unique constraint violation on "${table}"`);
            }

            throw error;
        }

        if (returned.length === 0) {
            throw new ConflictError(`optimistic concurrency conflict on "${table}" — the row changed during this mutation; refetch and retry`);
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
            columns: ["id", "_creationTime", ...fields].map((column) => quoteIdentifier(column)),
            values: [id, creationTime, ...fields.map((field) => serializeColumnValue(doc[field] ?? null))],
        };
    };

    const writer: DatabaseWriterLike = {
        async aggregate(tableName, aggOptions: AggregateOptions): Promise<AggregateResult> {
            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`unknown table: ${tableName}`);
            }

            // Reject an off-allowlist `op` up front (it's a compile-time-only
            // type) before it can reach any SQL-emitting path.
            aggregateSqlFunction(aggOptions.op);

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

            // No indexed fast-path for non-count reducers: the `__agg_`
            // companion stores a *row count* per `by`-group (the counter is
            // stepped by ±1 and backfilled by tallying +1/row, regardless of
            // the index's declared `op`). Reading it for sum/avg/min/max would
            // return the row COUNT, not the reduction. Until the counter is
            // made reducer-aware, sum/avg/min/max always fall through to the
            // SQL scan below, which computes the correct value. `count` never
            // reaches here (it early-returns to `writer.count` above, which
            // does use the counter).
            const effective = mergeWhere(aggOptions.baseWhere, aggOptions.where);
            const { params, sql: whereSql } = compileWhere(effective, d1WhereStrategy);

            let querySql = `SELECT ${aggregateSqlFunction(aggOptions.op)}(${columnRef(aggOptions.field)}) AS value FROM ${quoteIdentifier(tableName)}`;

            if (whereSql) {
                querySql += ` WHERE ${whereSql}`;
            }

            const rows = await exec.all(querySql, params);
            const value = rows[0]?.["value"];

            return value === null || value === undefined ? null : Number(value);
        },

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
                const planned = selectIndexForCount(definition.aggregateIndexes, opts.where);

                if (planned) {
                    const counterReady = await ensureBackfilled(tableName, planned.index);

                    if (counterReady) {
                        const encoded = encodeAggregateKey(planned.index.by ?? [], planned.key);
                        const aggTable = aggregateTableName(tableName, planned.index.name);
                        const rows = await exec.all(`SELECT "__value__" AS value FROM ${quoteIdentifier(aggTable)} WHERE "__key__" = ?`, [encoded]);

                        return Number(rows[0]?.["value"] ?? 0);
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

        async delete(id) {
            const tableName = await tableNameFromId(exec, schema, id, tableNameCache);

            if (!tableName) {
                return;
            }

            // Apply declared `onDelete` actions to holder rows before the
            // physical delete, mirroring the DO path. Snapshot the RAW stored
            // row up front so the optimistic-concurrency CAS below compares
            // stored-value to stored-value across the cascade `await` window.
            const definition = schema.tables[tableName];

            if (!definition) {
                return;
            }

            const snapshot = await rawRow(tableName, id);
            const existing = decodeRow(definition, snapshot);

            // `before` fires ahead of cascade resolution so a throwing guard
            // aborts the delete before any holder rows are touched.
            if (hasMatchingTrigger(tableName, "before", "delete")) {
                await fireTriggers("before", "delete", { id, op: "delete", previous: existing ?? undefined, table: tableName });
            }

            // D1 → shard cascade is the hard direction: holders that live on
            // a `.shardBy()` table are spread across many DOs and would need
            // Query Coordinator fan-out. v1 routes every holder through this
            // D1 writer — same-backend (D1 → D1) cascades work, and shard
            // holders simply won't have rows here so cascades are no-ops.
            // For the explicit shardBy case we'd want a hard error; deferred.
            await applyOnDelete({
                deletedId: id,
                deletedReference: (references) => existing?.[references],
                findHolders: async (holderTable, field, value) => {
                    if (schema.tables[holderTable]?.shardMode?.kind === "shardBy") {
                        throw new Error(
                            `cross-backend cascade from global '${tableName}' into shardBy '${holderTable}' is not supported — would require Query Coordinator fan-out across shards`,
                        );
                    }

                    const holders = await writer.findMany(holderTable, { where: { [field]: value } });

                    return holders.page;
                },
                onCascade: (_holderTable, holderId) => writer.delete(holderId),
                onRestrict: (message) => {
                    throw new ConflictError(message);
                },
                onSetNull: (_holderTable, holderId, field) => writer.patch(holderId, { [field]: null }),
                schema,
                tableName,
            });

            await ensureBackfilledForTable(tableName);
            await ensureRankBackfilledForTable(tableName);

            await runGuardedWrite(tableName, "DELETE", "", [], snapshot);

            // The id no longer lives in `tableName`; drop the stale cache entry
            // so a later re-insert of the same id into a different global table
            // re-probes instead of resolving to the now-empty original table.
            tableNameCache.delete(id);

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
                querySql += ` LIMIT ${String(limit + 1)}`;
            }

            const rows = await exec.all(querySql, params);
            const docs: Record<string, unknown>[] = [];

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
            const tableName = await tableNameFromId(exec, schema, id, tableNameCache);

            if (!tableName) {
                return null;
            }

            const definition = schema.tables[tableName];

            if (!definition) {
                return null;
            }

            const rows = await exec.all(`SELECT * FROM ${quoteIdentifier(tableName)} WHERE "id" = ?`, [id]);

            return decodeRow(definition, rows[0]);
        },

        async groupBy(tableName, groupOptions: GroupByOptions): Promise<ReadonlyArray<GroupByEntry>> {
            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`unknown table: ${tableName}`);
            }

            const agg = groupOptions.agg ?? { op: "count" };

            // Reject an off-allowlist reducer `op` before any SQL is emitted.
            aggregateSqlFunction(agg.op);

            if (agg.op !== "count" && !agg.field) {
                throw new Error(`groupBy(${tableName}, { agg: { op: "${agg.op}" } }): "field" is required for non-count reducers`);
            }

            // Indexed path: when no baseWhere is set and an aggregateIndex's
            // `by` exactly matches `groupOptions.by`, every group answer is
            // already in the companion table. baseWhere falls through to scan.
            //
            // Restricted to `count`: the `__agg_` companion stores a *row
            // count* per group regardless of the index's declared `op` (see
            // `stepAggregate`/`ensureBackfilled`), so reading it for
            // sum/avg/min/max would return counts. Non-count reducers fall
            // through to the correct SQL `GROUP BY` scan below.
            if (agg.op === "count" && definition.aggregateIndexes && !groupOptions.baseWhere) {
                const planned = selectIndexForGroupBy(definition.aggregateIndexes, agg.op, agg.field, groupOptions.by, groupOptions.where);

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
                // `agg.field` is asserted present for non-count reducers by the
                // guard above; re-check locally so the column ref stays typed
                // without a non-null assertion.
                if (!agg.field) {
                    throw new Error(`groupBy(${tableName}, { agg: { op: "${agg.op}" } }): "field" is required for non-count reducers`);
                }

                select.push(`${aggregateSqlFunction(agg.op)}(${columnRef(agg.field)}) AS value`);
            }

            let querySql = `SELECT ${select.join(", ")} FROM ${quoteIdentifier(tableName)}`;

            if (whereSql) {
                querySql += ` WHERE ${whereSql}`;
            }

            querySql += ` GROUP BY ${groupOptions.by.map((field) => columnRef(field)).join(", ")}`;

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

        /**
         * Insert a document. A client-chosen `_id` is **ignored** by default —
         * a caller able to pick its own id can collide with peer rows, defeat
         * unique constraints, and forge references in foreign tables. Only the
         * dev/admin import path (which round-trips a trusted snapshot) may opt
         * in via `options.allowExplicitId`, in which case a string `_id` on
         * `document` is used as the row's primary key. The default mutation
         * path always generates a fresh id even if a handler forwards a raw
         * client payload.
         */
        async insert(tableName, document, insertOptions) {
            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`unknown table: ${tableName}`);
            }

            const withDefaults = applyInsertDefaults(definition, document);

            // Refinements declared via `.check(predicate)` fire on the
            // post-default row so a defaulted value still passes its checks.
            runRowValidators(definition, withDefaults);

            const usedExplicitId = Boolean(insertOptions?.allowExplicitId) && typeof withDefaults["_id"] === "string";
            const id = usedExplicitId ? (withDefaults["_id"] as string) : generateId();
            const creationTime = typeof withDefaults["_creationTime"] === "number" ? withDefaults["_creationTime"] : clock();

            const docWithMeta: Record<string, unknown> = { ...withDefaults, _creationTime: creationTime, _id: id };

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

            // A caller-pinned id may collide with a stale cache entry from a
            // prior delete/re-insert in this ctx-db lifetime; point the cache
            // at the table the row now actually lives in. (Generated ids are
            // random and never pre-seeded, so this only matters for the
            // explicit-id import path.)
            if (usedExplicitId) {
                tableNameCache.set(id, tableName);
            }

            await syncAggregates(tableName, undefined, docWithMeta);
            await syncRanks(tableName, id, undefined, docWithMeta);

            if (hasMatchingTrigger(tableName, "after", "insert")) {
                await fireTriggers("after", "insert", { doc: docWithMeta, id, op: "insert", table: tableName });
            }

            return id;
        },

        async patch(id, patch) {
            const tableName = await tableNameFromId(exec, schema, id, tableNameCache);

            if (!tableName) {
                throw new Error(`document not found: ${id}`);
            }

            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`document not found: ${id}`);
            }

            // Capture the RAW stored row alongside the decoded `existing` — the
            // raw values seed the optimistic-concurrency CAS below, before the
            // before-update trigger's `await` window can let a concurrent write
            // slip in.
            const snapshot = await rawRow(tableName, id);
            const existing = decodeRow(definition, snapshot);

            if (!existing) {
                throw new Error(`document not found: ${id}`);
            }

            const merged: Record<string, unknown> = { ...existing, ...patch, _id: id };

            applyOnUpdate(definition, patch, merged);

            // Refinement checks fire on the merged row so a patch that flips
            // a field to an invalid value is rejected before D1 sees it.
            runRowValidators(definition, merged);

            if (hasMatchingTrigger(tableName, "before", "update")) {
                await fireTriggers("before", "update", { doc: { ...merged }, id, op: "update", previous: existing, table: tableName });
            }

            await ensureBackfilledForTable(tableName);
            await ensureRankBackfilledForTable(tableName);

            const fields = Object.keys(definition.shape);
            const assignments = fields.map((field) => `${quoteIdentifier(field)} = ?`).join(", ");
            const values = fields.map((field) => serializeColumnValue(merged[field] ?? null));

            await runGuardedWrite(tableName, "UPDATE", assignments, values, snapshot);

            await syncAggregates(tableName, existing, merged);
            await syncRanks(tableName, id, existing, merged);

            if (hasMatchingTrigger(tableName, "after", "update")) {
                await fireTriggers("after", "update", { doc: merged, id, op: "update", previous: existing, table: tableName });
            }
        },

        query() {
            throw new Error("the legacy query()/withIndex() reader is not available on the D1 (global) backend; use findMany");
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
            const sortColumnList = sortColumns.map((column) => quoteIdentifier(column)).join(", ");
            const ownRows = await exec.all(
                `SELECT "__partition__"${sortColumnList ? `, ${sortColumnList}` : ""} FROM ${quoteIdentifier(rankTable)} WHERE "__id__" = ?`,
                [rowId],
            );

            const own = ownRows[0];

            if (!own) {
                return null;
            }

            let partitionKey = own["__partition__"] as string;

            const effective = mergeWhere(rankOptions.baseWhere, rankOptions.where);
            const partitionFromWhere = resolveRankPartition(index, effective);

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
                    const prefixColumn = sortColumns[prefix];

                    if (prefixColumn === undefined) {
                        continue;
                    }

                    conditions.push(`${quoteIdentifier(prefixColumn)} IS ?`);
                    beforeParams.push(own[prefixColumn]);
                }

                const column = sortColumns[pivot];
                const sortKey = index.sortBy[pivot];

                if (pivot < sortColumns.length && column !== undefined && sortKey !== undefined) {
                    const operator = sortKey.direction === "desc" ? ">" : "<";

                    conditions.push(`${quoteIdentifier(column)} ${operator} ?`);
                    beforeParams.push(own[column]);
                } else {
                    conditions.push(`${quoteIdentifier(RANK_TIEBREAK)} < ?`);
                    beforeParams.push(rowId);
                }

                beforeBranches.push(conditions.length === 1 ? conditions.join(" AND ") : `(${conditions.join(" AND ")})`);
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
            const partitionFromWhere = resolveRankPartition(index, effective);

            const orderClauses: string[] = [`"__partition__" ASC`];

            for (const [i, sortKey] of index.sortBy.entries()) {
                orderClauses.push(`${quoteIdentifier(sortColumnName(i))} ${sortKey.direction === "desc" ? "DESC" : "ASC"}`);
            }

            orderClauses.push(`${quoteIdentifier(RANK_TIEBREAK)} ASC`);

            const whereClauses: string[] = [];
            const params: unknown[] = [];

            if (partitionFromWhere) {
                whereClauses.push(`"__partition__" = ?`);
                params.push(encodePartitionKey(index.partitionBy ?? [], partitionFromWhere));
            }

            if (rankPageOptions.cursor) {
                const decoded = decodeCursor(rankPageOptions.cursor);
                const expectedLength = 1 + sortColumns.length + 1;

                if (decoded.length === expectedLength) {
                    const cols: { column: string; direction: "asc" | "desc" }[] = [{ column: "__partition__", direction: "asc" }];

                    for (const [i, sortKey] of index.sortBy.entries()) {
                        cols.push({ column: sortColumnName(i), direction: sortKey.direction });
                    }

                    cols.push({ column: RANK_TIEBREAK, direction: "asc" });

                    const branches: string[] = [];

                    for (const [pivot, col] of cols.entries()) {
                        const conditions: string[] = [];

                        for (let prefix = 0; prefix < pivot; prefix += 1) {
                            const prefixCol = cols[prefix];

                            if (prefixCol === undefined) {
                                continue;
                            }

                            conditions.push(`${quoteIdentifier(prefixCol.column)} IS ?`);
                            params.push(decoded[prefix]);
                        }

                        const operator = col.direction === "desc" ? "<" : ">";

                        conditions.push(`${quoteIdentifier(col.column)} ${operator} ?`);
                        params.push(decoded[pivot]);
                        branches.push(conditions.length === 1 ? conditions.join(" AND ") : `(${conditions.join(" AND ")})`);
                    }

                    whereClauses.push(`(${branches.join(" OR ")})`);
                }
            }

            const sortColumnList = sortColumns.map((column) => quoteIdentifier(column)).join(", ");
            const idColumn = quoteIdentifier(RANK_TIEBREAK);
            const partitionColumn = `"__partition__"`;
            const innerWhere = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(" AND ")}` : "";
            const selectColumns = sortColumns.length > 0 ? `${idColumn}, ${partitionColumn}, ${sortColumnList}` : `${idColumn}, ${partitionColumn}`;
            const querySql = `SELECT ${selectColumns} FROM ${quoteIdentifier(rankTable)}${innerWhere} ORDER BY ${orderClauses.join(", ")} LIMIT ${String(take + 1)}`;
            const rankRows = await exec.all(querySql, params);
            const hasMore = rankRows.length > take;
            const usable = hasMore ? rankRows.slice(0, take) : rankRows;

            // Batched hydration: a single `IN (?, ?, …)` per chunk instead of
            // one SELECT per rank row. D1 documents a 100-parameter ceiling per
            // statement (https://developers.cloudflare.com/d1/platform/limits/),
            // so we chunk well below it to leave headroom for any future
            // wrapping params and to avoid skirting the limit. A 100-row page
            // used to issue 101 D1 queries; it now issues ⌈n/IN_CHUNK_SIZE⌉.
            const IN_CHUNK_SIZE = 50;
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
            const docs: Record<string, unknown>[] = [];

            for (const rankRow of usable) {
                const doc = decodeRow(definition, byId.get(rankRow[RANK_TIEBREAK] as string));

                if (doc) {
                    docs.push(doc);
                }
            }

            let continueCursor: null | string = null;

            const last = usable.at(-1);

            if (hasMore && last !== undefined) {
                const cursorValues: unknown[] = [last["__partition__"]];

                for (const column of sortColumns) {
                    cursorValues.push(last[column]);
                }

                cursorValues.push(last[RANK_TIEBREAK]);

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

        async replace(id, document) {
            const tableName = await tableNameFromId(exec, schema, id, tableNameCache);

            if (!tableName) {
                throw new Error(`document not found: ${id}`);
            }

            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`document not found: ${id}`);
            }

            // Always snapshot the RAW stored row — it seeds the optimistic-
            // concurrency CAS below. `previous` (the decoded prior doc) is only
            // needed when a trigger or an aggregate/rank index has to step the
            // old `by`-tuple; decode it from the same snapshot to avoid a second
            // round-trip.
            const snapshot = await rawRow(tableName, id);

            if (snapshot === undefined) {
                throw new Error(`document not found: ${id}`);
            }

            const needsPrevious =
                hasTrigger(schema, tableName, "update") || (definition.aggregateIndexes ?? []).length > 0 || (definition.rankIndexes ?? []).length > 0;
            const previous = needsPrevious ? (decodeRow(definition, snapshot) ?? undefined) : undefined;
            const creationTime = typeof document["_creationTime"] === "number" ? document["_creationTime"] : clock();
            const replaced: Record<string, unknown> = { ...document, _creationTime: creationTime, _id: id };

            applyOnUpdate(definition, document, replaced);

            // Refinement checks fire on the post-onUpdate row so a defaulted
            // field still has to satisfy its `.check()` predicate.
            runRowValidators(definition, replaced);

            if (hasMatchingTrigger(tableName, "before", "update")) {
                await fireTriggers("before", "update", { doc: { ...replaced }, id, op: "update", previous, table: tableName });
            }

            await ensureBackfilledForTable(tableName);
            await ensureRankBackfilledForTable(tableName);

            const fields = Object.keys(definition.shape);
            const assignments = ['"_creationTime" = ?', ...fields.map((field) => `${quoteIdentifier(field)} = ?`)].join(", ");
            const values = [creationTime, ...fields.map((field) => serializeColumnValue(replaced[field] ?? null))];

            await runGuardedWrite(tableName, "UPDATE", assignments, values, snapshot);

            await syncAggregates(tableName, previous, replaced);
            await syncRanks(tableName, id, previous, replaced);

            if (hasMatchingTrigger(tableName, "after", "update")) {
                await fireTriggers("after", "update", { doc: replaced, id, op: "update", previous, table: tableName });
            }
        },
    };

    triggerCtx = { db: writer, scheduler };

    return writer;
};

/**
 * Materialize the `__agg_&lt;index>` companion tables for every declared
 * `aggregateIndex` on a global table. Global tables in Cirrus ship their own
 * DDL — counter tables are opt-in so production hosts can decide where they
 * live. Tests and dev hosts can call this once after their schema migration to
 * unlock O(1) counts.
 *
 * Idempotent (`CREATE TABLE IF NOT EXISTS`).
 */
const runD1AggregateMigrations = async (exec: D1Exec, schema: SchemaLike): Promise<void> => {
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
 * Materialize the `__rank_&lt;index>` companion tables for every declared
 * `rankIndex` on a global table. Mirrors `runD1AggregateMigrations` — same
 * opt-in pattern so production hosts decide whether to spend the DDL.
 *
 * Idempotent (`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`).
 */
const runD1RankMigrations = async (exec: D1Exec, schema: SchemaLike): Promise<void> => {
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

            for (const [i, sortKey] of index.sortBy.entries()) {
                orderedColumns.push(`${quoteIdentifier(sortColumnName(i))} ${sortKey.direction === "desc" ? "DESC" : "ASC"}`);
            }

            orderedColumns.push('"__id__" ASC');

            const btreeName = `${tableName}__rank_${index.name}__btree`;

            await exec.run(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(btreeName)} ON ${quoteIdentifier(rankTable)} (${orderedColumns.join(", ")})`, []);
        }
    }
};

export { createD1CtxDb, runD1AggregateMigrations, runD1RankMigrations };
export type { D1CtxDbOptions, D1Exec };
