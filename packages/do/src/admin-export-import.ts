/**
 * Per-shard admin bulk export/import helpers.
 *
 * The `convex import`/`convex export` analog. The runtime fans calls out per
 * shard via {@link orchestrateExport}/{@link orchestrateImport}; each shard runs
 * the helpers below against its own SQLite handle. NDJSON is emitted as a
 * `{table,doc}` row per line — no enveloping array — so the worker can stream
 * the response without buffering the whole snapshot in memory.
 *
 * Globally-scoped (`.global()`) tables live in D1, not the DO, so this module
 * deliberately skips them — the worker reads them through `@cirrus/d1`'s
 * sibling helpers and concatenates the two streams.
 */
import type { DatabaseWriterLike, SchemaLike, SqlExec } from "./ctx-db.js";

/** One NDJSON line: a row from `table` shaped per its schema. */
export interface ExportRow {
    doc: Record<string, unknown>;
    table: string;
}

/**
 * One row that could not be inserted during an import. The line number is
 * 1-based and refers to the row's position in the inbound stream the shard
 * received — handy when correlating bulk-import failures with the source file.
 */
export interface ImportError {
    code: string;
    line: number;
    message: string;
    table: string;
}

export interface ExportShardArgs {
    /**
     * Per-table batch size when scanning. Defaults to 200 — keeps individual
     * SQLite `SELECT`s small enough that a stream cancellation surfaces
     * promptly instead of waiting on a huge page to finish materializing.
     */
    batchSize?: number;
    /**
     * Tables to export. When omitted, every shard-local user table in the
     * schema is exported. Globals are always skipped — the worker handles those.
     */
    tables?: ReadonlyArray<string>;
}

export interface ImportShardArgs {
    /** Inbound NDJSON rows. Order is preserved on disk. */
    rows: ReadonlyArray<ExportRow>;
    /** Starting line number (1-based) for error attribution. Defaults to 1. */
    startLine?: number;
}

export interface ImportShardResult {
    /** Skipped rows whose `_id` conflicted with an existing document. */
    conflicts: number;
    errors: ImportError[];
    /** Number of rows successfully inserted, per table. */
    inserted: Record<string, number>;
}

const DEFAULT_BATCH_SIZE = 200;

/**
 * Filter the schema's table list down to the shard-local user tables that
 * should be exported. `.global()` tables are excluded; an explicit allowlist
 * narrows further. Order: schema-declaration order, then allowlist order.
 */
export const selectExportTables = (schema: SchemaLike, requested?: ReadonlyArray<string>): string[] => {
    const isShardLocal = (table: string): boolean => {
        const definition = schema.tables[table];

        if (!definition) {
            return false;
        }

        return definition.shardMode?.kind !== "global";
    };

    if (requested && requested.length > 0) {
        const filtered: string[] = [];

        for (const name of requested) {
            if (isShardLocal(name)) {
                filtered.push(name);
            }
        }

        return filtered;
    }

    const result: string[] = [];

    for (const name of Object.keys(schema.tables)) {
        if (isShardLocal(name)) {
            result.push(name);
        }
    }

    return result;
};

/**
 * Read every row in `table` and yield it as an {@link ExportRow}. Walks in
 * keyset batches of `batchSize` (default 200) so a 1M-row table doesn't
 * inflate the JS heap with a single materialized array.
 */
export const exportShardTable = async function* (
    writer: DatabaseWriterLike,
    table: string,
    batchSize: number = DEFAULT_BATCH_SIZE,
): AsyncGenerator<ExportRow, void, undefined> {
    let cursor: null | string = null;

    while (true) {
        const page = await writer.findMany(table, { cursor, limit: batchSize });

        for (const doc of page.page) {
            yield { doc, table };
        }

        if (page.isDone) {
            return;
        }

        cursor = page.continueCursor;

        if (cursor === null) {
            return;
        }
    }
};

/**
 * Yield every {@link ExportRow} this shard owns across `tables`. Tables are
 * walked in the order returned by {@link selectExportTables}.
 */
export const exportShardRows = async function* (
    writer: DatabaseWriterLike,
    schema: SchemaLike,
    args: ExportShardArgs,
): AsyncGenerator<ExportRow, void, undefined> {
    const tables = selectExportTables(schema, args.tables);
    const batchSize = args.batchSize ?? DEFAULT_BATCH_SIZE;

    for (const table of tables) {
        yield* exportShardTable(writer, table, batchSize);
    }
};

/**
 * Validate `doc` against the table's declared `defineTable({...})` shape, the
 * same parser path `validateArgs` uses for function args. Returns `null` on
 * success or an error string. `_id` and `_creationTime` are tolerated as raw
 * fields and re-applied on the writer side — the shape parser otherwise
 * rejects unknown keys.
 */
export const validateImportRow = (schema: SchemaLike, table: string, doc: Record<string, unknown>): null | string => {
    const definition = schema.tables[table];

    if (!definition) {
        return `unknown table: ${table}`;
    }

    // Globals live in D1, not the shard — refuse them here so a crafted row
    // can't smuggle a `.global()` table through the shard import path. Mirror
    // `selectExportTables`' shard-local check exactly.
    if (definition.shardMode?.kind === "global") {
        return `table "${table}" is a global (.global()) table and is not importable through the shard import path`;
    }

    // Strip framework-managed fields before validating against the user shape.
    // Both are reapplied verbatim on insert so the round-trip is byte-identical.
    const { _creationTime, _id, ...payload } = doc;

    void _creationTime;
    void _id;

    // Reject keys that aren't declared in the table's shape (nor the
    // framework-managed `_id`/`_creationTime` already stripped above).
    // Otherwise an undeclared field passes validation untouched and gets
    // persisted verbatim by the writer.
    for (const key of Object.keys(payload)) {
        if (!(key in definition.shape)) {
            return `unexpected field "${key}": not declared in table "${table}"`;
        }
    }

    for (const [field, validator] of Object.entries(definition.shape)) {
        const candidate = (payload as Record<string, unknown>)[field];
        const optional = validator.kind === "optional";

        if (candidate === undefined && optional) {
            continue;
        }

        const parser = (validator as { parse?: (value: unknown) => unknown }).parse;

        if (typeof parser !== "function") {
            // Validator surface in this package is structural; if a validator
            // omits `parse` we conservatively skip the per-field check rather
            // than reject every row.
            continue;
        }

        try {
            parser(candidate);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);

            return `field "${field}": ${message}`;
        }
    }

    return null;
};

/**
 * Re-insert every row in `args.rows` through the writer, validating each one
 * against the table's declared shape. Rows that fail validation are recorded
 * in the result's `errors` array; rows whose `_id` already exists in the table
 * are counted in `conflicts` and skipped (the v1 mode is `append` — no
 * upsert). All `inserted` counts are bucketed per table.
 *
 * The writer is responsible for invoking this from within the appropriate
 * transaction; this helper takes no SQL handle of its own.
 */
export const importShardRows = async (writer: DatabaseWriterLike, schema: SchemaLike, args: ImportShardArgs): Promise<ImportShardResult> => {
    const errors: ImportError[] = [];
    const inserted: Record<string, number> = {};
    let conflicts = 0;
    let line = (args.startLine ?? 1) - 1;

    for (const row of args.rows) {
        line += 1;

        const { doc, table } = row;

        if (typeof table !== "string" || table.length === 0) {
            errors.push({ code: "BAD_ROW", line, message: "row is missing `table`", table });
            continue;
        }

        if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
            errors.push({ code: "BAD_ROW", line, message: "row is missing or malformed `doc`", table });
            continue;
        }

        const failure = validateImportRow(schema, table, doc);

        if (failure !== null) {
            errors.push({ code: "VALIDATION_ERROR", line, message: failure, table });
            continue;
        }

        // v1 mode is `append`: when `_id` collides, skip the row and surface
        // the count rather than upserting.
        const explicitId = typeof doc["_id"] === "string" ? (doc["_id"]) : undefined;

        if (explicitId !== undefined) {
            try {
                const existing = await writer.get(explicitId);

                if (existing !== null) {
                    conflicts += 1;
                    continue;
                }
            } catch {
                // `get` probes every table; an unknown-table failure here is
                // surfaced when the insert below runs against the real schema.
            }
        }

        try {
            // Trusted import path: this is a snapshot round-trip, so a
            // `_id` carried on the row is intentional and must be preserved
            // (the default mutation path drops client-chosen ids).
            await writer.insert(table, doc, { allowExplicitId: true });
            inserted[table] = (inserted[table] ?? 0) + 1;
        } catch (error: unknown) {
            const code = (error as { code?: string }).code ?? "INSERT_FAILED";
            const message = error instanceof Error ? error.message : String(error);

            errors.push({ code, line, message, table });
        }
    }

    return { conflicts, errors, inserted };
};

/** Arguments accepted by the `__cirrus_admin__:exportShard` admin RPC. */
export interface ExportShardAdminArgs {
    batchSize?: number;
    tables?: ReadonlyArray<string>;
}

/** Arguments accepted by the `__cirrus_admin__:importShard` admin RPC. */
export interface ImportShardAdminArgs {
    rows: ReadonlyArray<ExportRow>;
    startLine?: number;
}

/**
 * Coerce loosely-typed admin args into the export shape. Unknown fields fall
 * through to defaults — the wire surface is forgiving so a stale CLI can still
 * talk to a newer worker.
 */
export const parseExportShardArgs = (args: Record<string, unknown>): ExportShardAdminArgs => {
    const tables = Array.isArray(args["tables"]) ? (args["tables"] as unknown[]).filter((entry): entry is string => typeof entry === "string") : undefined;
    const batchSize = typeof args["batchSize"] === "number" ? (args["batchSize"]) : undefined;

    return { batchSize, tables };
};

/** Coerce loosely-typed admin args into the import shape. */
export const parseImportShardArgs = (args: Record<string, unknown>): ImportShardAdminArgs => {
    const rawRows = Array.isArray(args["rows"]) ? (args["rows"] as unknown[]) : [];
    const rows: ExportRow[] = [];

    for (const entry of rawRows) {
        if (!entry || typeof entry !== "object") {
            continue;
        }

        const candidate = entry as { doc?: unknown; table?: unknown };

        if (typeof candidate.table !== "string" || !candidate.doc || typeof candidate.doc !== "object" || Array.isArray(candidate.doc)) {
            // Malformed envelope rows are rejected during validation downstream
            // — but we keep the envelope so the line numbers stay aligned.
            rows.push({ doc: (candidate.doc as Record<string, unknown>) ?? {}, table: typeof candidate.table === "string" ? candidate.table : "" });
            continue;
        }

        rows.push({ doc: candidate.doc as Record<string, unknown>, table: candidate.table });
    }

    const startLine = typeof args["startLine"] === "number" ? (args["startLine"]) : undefined;

    return { rows, startLine };
};

/** Reserved sql handle threading for callers that need it (no-op default). */
void (null as unknown as SqlExec);
