/**
 * Per-shard admin bulk export/import helpers.
 *
 * The `convex import`/`convex export` analog. The runtime fans calls out per
 * shard via `orchestrateExport`/`orchestrateImport`; each shard runs
 * the helpers below against its own SQLite handle. NDJSON is emitted as a
 * `{table,doc}` row per line — no enveloping array — so the worker can stream
 * the response without buffering the whole snapshot in memory.
 *
 * Globally-scoped (`.global()`) tables live in D1, not the DO, so this module
 * deliberately skips them — the worker reads them through `@lunora/d1`'s
 * sibling helpers and concatenates the two streams.
 */
import { toErrorBody } from "@lunora/errors";

import { COMMIT_SEQ_FIELD } from "./ctx-db-commit-seq";
import type { DatabaseWriterLike, SchemaLike } from "./schema-types";

/** One NDJSON line: a row from `table` shaped per its schema. */
interface ExportRow {
    doc: Record<string, unknown>;
    table: string;
}

/**
 * One row that could not be inserted during an import. The line number is
 * 1-based and refers to the row's position in the inbound stream the shard
 * received — handy when correlating bulk-import failures with the source file.
 */
interface ImportError {
    code: string;
    line: number;
    message: string;
    table: string;
}

interface ExportShardArgs {
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

interface ImportShardArgs {
    /** Inbound NDJSON rows. Order is preserved on disk. */
    rows: ReadonlyArray<ExportRow>;
    /** Starting line number (1-based) for error attribution. Defaults to 1. */
    startLine?: number;
}

interface ImportShardResult {
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
const selectExportTables = (schema: SchemaLike, requested?: ReadonlyArray<string>): string[] => {
    const isShardLocal = (table: string): boolean => {
        const definition = schema.tables[table];

        return definition !== undefined && definition.shardMode?.kind !== "global";
    };

    return (requested && requested.length > 0 ? [...requested] : Object.keys(schema.tables)).filter((name) => isShardLocal(name));
};

/**
 * Read every row in `table` and yield it as an {@link ExportRow}. Walks in
 * keyset batches of `batchSize` (default 200) so a 1M-row table doesn't
 * inflate the JS heap with a single materialized array.
 */
const exportShardTable = async function* (
    writer: DatabaseWriterLike,
    table: string,
    batchSize: number = DEFAULT_BATCH_SIZE,
): AsyncGenerator<ExportRow, void, undefined> {
    // eslint-disable-next-line unicorn/no-null -- keyset cursor sentinel: null means "start of table", matching QueryArgs.cursor's wire type
    let cursor: null | string = null;
    let done = false;

    while (!done) {
        // eslint-disable-next-line no-await-in-loop -- keyset pagination: each page's cursor depends on the previous page
        const page = await writer.findMany(table, { cursor, limit: batchSize });

        for (const record of page.page) {
            yield { doc: record, table };
        }

        cursor = page.continueCursor;
        // Stop when the reader says it's done or hands back no further cursor.
        done = page.isDone || cursor === null;
    }
};

/**
 * Yield every {@link ExportRow} this shard owns across `tables`. Tables are
 * walked in the order returned by {@link selectExportTables}.
 */
const exportShardRows = async function* (writer: DatabaseWriterLike, schema: SchemaLike, args: ExportShardArgs): AsyncGenerator<ExportRow, void, undefined> {
    const tables = selectExportTables(schema, args.tables);
    const batchSize = args.batchSize ?? DEFAULT_BATCH_SIZE;

    for (const table of tables) {
        yield* exportShardTable(writer, table, batchSize);
    }
};

/** Framework-managed fields stripped before shape validation and re-applied verbatim on insert. */
const FRAMEWORK_FIELDS = new Set(["_creationTime", "_id"]);

/**
 * Run each declared column's parser against `payload`. Returns an error string
 * on the first failure, or `undefined` when every field validates.
 * @returns an error string on the first validation failure, or `undefined` when every field is valid
 */
const validateAgainstShape = (definition: SchemaLike["tables"][string], payload: Record<string, unknown>): string | undefined => {
    for (const [field, validator] of Object.entries(definition.shape)) {
        const candidate = payload[field];

        if (candidate === undefined && validator.kind === "optional") {
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

    return undefined;
};

/**
 * Validate `record` against the table's declared `defineTable({...})` shape, the
 * same parser path `validateArgs` uses for function args. Returns `undefined` on
 * success or an error string. `_id` and `_creationTime` are tolerated as raw
 * fields and re-applied on the writer side — the shape parser otherwise
 * rejects unknown keys.
 * @returns `undefined` on success, or an error string describing the first validation failure
 */
const validateImportRow = (schema: SchemaLike, table: string, record: Record<string, unknown>): string | undefined => {
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
    const payload = Object.fromEntries(Object.entries(record).filter(([key]) => !FRAMEWORK_FIELDS.has(key)));

    // Reject keys that aren't declared in the table's shape (nor the
    // framework-managed `_id`/`_creationTime` already stripped above).
    // Otherwise an undeclared field passes validation untouched and gets
    // persisted verbatim by the writer.
    //
    // `Object.hasOwn`, never `key in shape`: `in` walks the prototype chain, so
    // `constructor`, `toString` and `__proto__` passed as declared fields and
    // reached the writer unvalidated.
    for (const key of Object.keys(payload)) {
        if (!Object.hasOwn(definition.shape, key)) {
            return `unexpected field "${key}": not declared in table "${table}"`;
        }
    }

    return validateAgainstShape(definition, payload);
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
/** Outcome of importing one row: a recorded error, a skipped conflict, or a successful insert into `table`. */
type RowOutcome = { error: ImportError; kind: "error" } | { kind: "conflict" } | { kind: "inserted"; table: string };

/** Probe whether a row with `explicitId` already exists (append mode skips collisions). */
const idAlreadyExists = async (writer: DatabaseWriterLike, explicitId: string): Promise<boolean> => {
    try {
        const existing = await writer.get(explicitId);

        return existing !== null;
    } catch {
        // `get` probes every table; an unknown-table failure here is surfaced
        // when the insert runs against the real schema.
        return false;
    }
};

/**
 * Drop the system fields the writer re-derives on insert.
 *
 * `_commitSeq` is injected into the stored document of every `.commitOrdered()`
 * table (see `ctx-db-commit-seq.ts`) and so rides out on export — but it is
 * neither a framework field nor declared in `definition.shape`, so validation
 * rejected it as an "unexpected field" and EVERY row of such a table failed to
 * restore (with the request still returning 200 and an `errors` array).
 *
 * Stripped rather than tolerated: the value is a PER-SHARD counter, so replaying
 * one shard's numbering into another would break the `_commitSeq > cursor`
 * monotonicity the changefeed depends on. `insert` allocates a fresh one.
 */
const stripDerivedFields = (document: Record<string, unknown>): Record<string, unknown> =>
    COMMIT_SEQ_FIELD in document ? Object.fromEntries(Object.entries(document).filter(([key]) => key !== COMMIT_SEQ_FIELD)) : document;

/** Validate, conflict-check and insert one inbound row, returning its outcome. */
const importOneRow = async (writer: DatabaseWriterLike, schema: SchemaLike, row: ExportRow, line: number): Promise<RowOutcome> => {
    const { table } = row;
    let { doc } = row;

    if (typeof table !== "string" || table.length === 0) {
        return { error: { code: "BAD_ROW", line, message: "row is missing `table`", table }, kind: "error" };
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `doc` is parsed wire data; the declared type can't be trusted at runtime
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
        return { error: { code: "BAD_ROW", line, message: "row is missing or malformed `doc`", table }, kind: "error" };
    }

    doc = stripDerivedFields(doc);

    const failure = validateImportRow(schema, table, doc);

    if (failure !== undefined) {
        return { error: { code: "VALIDATION_ERROR", line, message: failure, table }, kind: "error" };
    }

    // v1 mode is `append`: when `_id` collides, skip the row and count it.
    const explicitId = typeof doc["_id"] === "string" ? doc["_id"] : undefined;

    if (explicitId !== undefined && (await idAlreadyExists(writer, explicitId))) {
        return { kind: "conflict" };
    }

    try {
        // Trusted import path: this is a snapshot round-trip, so a `_id`
        // carried on the row is intentional and must be preserved (the default
        // mutation path drops client-chosen ids).
        await writer.insert(table, doc, { allowExplicitId: true });

        return { kind: "inserted", table };
    } catch (error: unknown) {
        // Routed through `toErrorBody` rather than the naked `error.message`/`.code`
        // this used to embed directly: a recognized `LunoraError` (e.g. the
        // `NOT_UNIQUE` conflict `ctx-db.ts` throws on an `_id` collision) still
        // surfaces its real code/message, but an internal-coded or unrecognized
        // throw is redacted instead of leaking raw error text into the admin
        // import response.
        const { body } = toErrorBody(error, { fallbackCode: "INSERT_FAILED" });

        return { error: { code: body.code, line, message: body.message, table }, kind: "error" };
    }
};

const importShardRows = async (writer: DatabaseWriterLike, schema: SchemaLike, args: ImportShardArgs): Promise<ImportShardResult> => {
    const errors: ImportError[] = [];
    const inserted: Record<string, number> = {};
    let conflicts = 0;
    let line = (args.startLine ?? 1) - 1;

    for (const row of args.rows) {
        line += 1;

        // eslint-disable-next-line no-await-in-loop -- rows are inserted in stream order through one SQLite handle; line-number attribution depends on the sequence
        const outcome = await importOneRow(writer, schema, row, line);

        if (outcome.kind === "error") {
            errors.push(outcome.error);
        } else if (outcome.kind === "conflict") {
            conflicts += 1;
        } else {
            inserted[outcome.table] = (inserted[outcome.table] ?? 0) + 1;
        }
    }

    return { conflicts, errors, inserted };
};

/** Arguments accepted by the `__lunora_admin__:exportShard` admin RPC. */
interface ExportShardAdminArgs {
    batchSize?: number;
    tables?: ReadonlyArray<string>;
}

/** Arguments accepted by the `__lunora_admin__:importShard` admin RPC. */
interface ImportShardAdminArgs {
    rows: ReadonlyArray<ExportRow>;
    startLine?: number;
}

/**
 * Coerce loosely-typed admin args into the export shape. Unknown fields fall
 * through to defaults — the wire surface is forgiving so a stale CLI can still
 * talk to a newer worker.
 */
const parseExportShardArgs = (args: Record<string, unknown>): ExportShardAdminArgs => {
    const tables = Array.isArray(args["tables"]) ? (args["tables"] as unknown[]).filter((entry): entry is string => typeof entry === "string") : undefined;
    const batchSize = typeof args["batchSize"] === "number" ? args["batchSize"] : undefined;

    return { batchSize, tables };
};

/** Coerce loosely-typed admin args into the import shape. */
const parseImportShardArgs = (args: Record<string, unknown>): ImportShardAdminArgs => {
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
            rows.push({ doc: (candidate.doc as Record<string, unknown> | undefined) ?? {}, table: typeof candidate.table === "string" ? candidate.table : "" });
            continue;
        }

        rows.push({ doc: candidate.doc as Record<string, unknown>, table: candidate.table });
    }

    const startLine = typeof args["startLine"] === "number" ? args["startLine"] : undefined;

    return { rows, startLine };
};

export { exportShardRows, importShardRows, parseExportShardArgs, parseImportShardArgs, selectExportTables, validateImportRow };
export type { ExportRow, ExportShardAdminArgs, ExportShardArgs, ImportError, ImportShardAdminArgs, ImportShardArgs, ImportShardResult };
