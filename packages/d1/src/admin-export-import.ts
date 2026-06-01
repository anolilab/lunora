/**
 * D1 admin bulk export/import for `.global()` tables.
 *
 * Twin of `@cirrus/do`'s `admin-export-import.ts`, except every read/write is
 * an async `D1Exec` call (real columns instead of JSON blobs). The worker
 * stitches D1 globals and per-shard DO output into a single NDJSON stream.
 */
import type { DatabaseWriterLike, SchemaLike } from "@cirrus/do";

import type { D1Exec } from "./d1-ctx-db.js";

/** One exported row: `doc` is reconstructed from the column tuple. */
interface ExportRow {
    doc: Record<string, unknown>;
    table: string;
}

interface ImportError {
    code: string;
    line: number;
    message: string;
    table: string;
}

interface ImportResult {
    /** Skipped rows whose `_id` already exists. */
    conflicts: number;
    errors: ImportError[];
    inserted: Record<string, number>;
}

const DEFAULT_BATCH_SIZE = 200;

const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/**
 * Return every `.global()` table in the schema, optionally narrowed by an
 * allowlist. Shard-local tables are skipped here — they're handled by the DO
 * helpers — so callers get a clean separation between the two storage planes.
 */
const selectGlobalTables = (schema: SchemaLike, requested?: ReadonlyArray<string>): string[] => {
    const isGlobal = (table: string): boolean => schema.tables[table]?.shardMode?.kind === "global";

    if (requested && requested.length > 0) {
        return requested.filter((name) => isGlobal(name));
    }

    return Object.keys(schema.tables).filter((name) => isGlobal(name));
};

/**
 * Decode a SELECTed D1 row back into a doc the same way `d1-ctx-db.ts`'s
 * `decodeRow` does — re-exposing `_id` (from the `id` column), preserving
 * `_creationTime`, and folding 1/0 back into booleans for boolean fields.
 */
const decodeRow = (schema: SchemaLike, table: string, row: Record<string, unknown>): Record<string, unknown> => {
    const definition = schema.tables[table];
    const decoded: Record<string, unknown> = {};

    if (definition) {
        for (const [field, validator] of Object.entries(definition.shape)) {
            const raw = row[field];

            if (raw === undefined) {
                continue;
            }

            decoded[field] = validator.kind === "boolean" && (raw === 0 || raw === 1) ? raw === 1 : raw;
        }
    }

    decoded["_id"] = row["id"];
    decoded["_creationTime"] = row["_creationTime"];

    return decoded;
};

interface ExportGlobalArgs {
    batchSize?: number;
    tables?: ReadonlyArray<string>;
}

/**
 * Yield rows from every requested `.global()` table in batches. Uses
 * `LIMIT ?/OFFSET ?` because D1 globals don't have a stable keyset abstraction
 * here (the writer's `findMany` does, but at the cost of routing through the
 * full validator pipeline; for a snapshot stream a plain offset scan is
 * sufficient and predictable).
 */
const exportGlobalRows = async function* (exec: D1Exec, schema: SchemaLike, args: ExportGlobalArgs): AsyncGenerator<ExportRow, void, undefined> {
    const tables = selectGlobalTables(schema, args.tables);
    const batchSize = args.batchSize ?? DEFAULT_BATCH_SIZE;

    for (const table of tables) {
        let offset = 0;
        let hasMore = true;

        while (hasMore) {
            // eslint-disable-next-line no-await-in-loop -- offset paging is inherently sequential: each page's OFFSET depends on the prior page count.
            const rows = await exec.all(`SELECT * FROM ${quoteIdentifier(table)} LIMIT ? OFFSET ?`, [batchSize, offset]);

            for (const row of rows) {
                yield { doc: decodeRow(schema, table, row), table };
            }

            hasMore = rows.length === batchSize;
            offset += rows.length;
        }
    }
};

const validateRow = (schema: SchemaLike, table: string, document: Record<string, unknown>): string | undefined => {
    const definition = schema.tables[table];

    if (!definition) {
        return `unknown table: ${table}`;
    }

    // Only declared schema fields are validated; `definition.shape` never
    // contains the system fields (`_id`, `_creationTime`), so reading straight
    // off `document` already skips them.
    for (const [field, validator] of Object.entries(definition.shape)) {
        const candidate = document[field];
        const optional = validator.kind === "optional";

        if (candidate === undefined && optional) {
            continue;
        }

        const parser = (validator as { parse?: (value: unknown) => unknown }).parse;

        if (typeof parser !== "function") {
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

interface ImportGlobalArgs {
    /**
     * Optional direct exec handle to the same D1 database the writer targets.
     * When supplied, the conflict pre-probe issues a single
     * `SELECT 1 FROM &lt;table> WHERE id = ? LIMIT 1` against the row's declared
     * table instead of falling back to `writer.get(id)`, which scans every
     * global table looking for the id. Strongly recommended for large schemas
     * — the writer-fallback is O(N tables) per row.
     */
    exec?: D1ExecLike;
    rows: ReadonlyArray<ExportRow>;
    startLine?: number;
}

/** Minimal slice of `D1Exec` (declared locally to avoid a circular import). */
interface D1ExecLike {
    all: (sql: string, parameters: ReadonlyArray<unknown>) => Promise<Record<string, unknown>[]>;
}

/**
 * Probe whether `explicitId` already exists in `table`. Prefers a direct
 * table+id `SELECT` when an exec handle is available (avoids the writer.get()
 * fallback's per-row N-table scan). A probe error is swallowed — the writer's
 * insert path will surface any hard error instead.
 */
const explicitIdConflicts = async (writer: DatabaseWriterLike, exec: D1ExecLike | undefined, table: string, explicitId: string): Promise<boolean> => {
    try {
        if (exec) {
            const probe = await exec.all(`SELECT 1 AS hit FROM ${quoteIdentifier(table)} WHERE "id" = ? LIMIT 1`, [explicitId]);

            return probe.length > 0;
        }

        const existing = await writer.get(explicitId);

        return existing !== null;
    } catch {
        // The writer's insert path will surface a hard error if one is real.
        return false;
    }
};

type RowOutcome = { error: ImportError; kind: "error" } | { inserted: string; kind: "inserted" } | { kind: "conflict" } | { kind: "skip" };

/** Resolve one import row to a single outcome, isolating the per-row branching from the accumulation loop. */
const importOneRow = async (writer: DatabaseWriterLike, schema: SchemaLike, args: ImportGlobalArgs, row: ExportRow, line: number): Promise<RowOutcome> => {
    const { doc, table } = row;

    // Only process globals here; shard-local rows are someone else's
    // responsibility (the DO importers handle those).
    if (schema.tables[table]?.shardMode?.kind !== "global") {
        return { kind: "skip" };
    }

    // Defensive against untrusted snapshot rows: `doc` is typed non-null, but
    // an import payload can carry a missing/malformed `doc` off the wire.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- guard on untrusted parsed NDJSON, not on the declared type
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
        return { error: { code: "BAD_ROW", line, message: "row is missing or malformed `doc`", table }, kind: "error" };
    }

    const failure = validateRow(schema, table, doc);

    if (failure !== undefined) {
        return { error: { code: "VALIDATION_ERROR", line, message: failure, table }, kind: "error" };
    }

    const explicitId = typeof doc["_id"] === "string" ? doc["_id"] : undefined;

    if (explicitId !== undefined && (await explicitIdConflicts(writer, args.exec, table, explicitId))) {
        return { kind: "conflict" };
    }

    try {
        // Trusted admin import path: preserve the pinned `_id` from the
        // snapshot (the default insert path now strips client-chosen ids).
        await writer.insert(table, doc, { allowExplicitId: true });

        return { inserted: table, kind: "inserted" };
    } catch (error: unknown) {
        const code = (error as { code?: string }).code ?? "INSERT_FAILED";
        const message = error instanceof Error ? error.message : String(error);

        return { error: { code, line, message, table }, kind: "error" };
    }
};

/**
 * Import rows into `.global()` tables via the schema-aware D1 writer. The
 * writer rejects unknown ids on `insert` (the writer assigns one when `_id` is
 * absent); we pre-probe each row's `_id` so a collision is reported as a
 * conflict instead of bubbled as a UNIQUE error. Schema-failed rows surface in
 * `errors`; the rest land.
 */
const importGlobalRows = async (writer: DatabaseWriterLike, schema: SchemaLike, args: ImportGlobalArgs): Promise<ImportResult> => {
    const errors: ImportError[] = [];
    const inserted: Record<string, number> = {};
    let conflicts = 0;
    let line = (args.startLine ?? 1) - 1;

    for (const row of args.rows) {
        line += 1;

        // eslint-disable-next-line no-await-in-loop -- imports apply row-by-row in input order so per-line error/conflict reporting and the shared writer stay deterministic.
        const outcome = await importOneRow(writer, schema, args, row, line);

        switch (outcome.kind) {
            case "conflict": {
                conflicts += 1;
                break;
            }

            case "error": {
                errors.push(outcome.error);
                break;
            }

            case "inserted": {
                inserted[outcome.inserted] = (inserted[outcome.inserted] ?? 0) + 1;
                break;
            }

            default: {
                break;
            }
        }
    }

    return { conflicts, errors, inserted };
};

export { exportGlobalRows, importGlobalRows, selectGlobalTables };
export type { D1ExecLike, ExportGlobalArgs, ExportRow, ImportError, ImportGlobalArgs, ImportResult };
