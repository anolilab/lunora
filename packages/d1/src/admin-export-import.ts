/**
 * D1 admin bulk export/import for `.global()` tables.
 *
 * Twin of `@lunora/do`'s `admin-export-import.ts`, except every read/write is
 * an async `D1Exec` call (real columns instead of JSON blobs). The worker
 * stitches D1 globals and per-shard DO output into a single NDJSON stream.
 */
import { toErrorBody } from "@lunora/errors";
import type { DatabaseWriterLike, SchemaLike } from "@lunora/shard-engine";

import { decodeWire, encodeWire, needsWireEncoding } from "../../../shared/wire-codec";
import type { D1Exec } from "./d1-ctx-db";
import { decodeGlobalRow, runD1GlobalTableMigrations } from "./d1-ctx-db";
import { quoteIdentifier } from "./dialect";

/** One exported row: `doc` is reconstructed from the column tuple. */
interface ExportRow {
    doc: Record<string, unknown>;

    /**
     * True physical source line, when the caller has it (e.g. a global row
     * pulled out of an interspersed NDJSON import stream by
     * `@lunora/runtime`'s `import-stream.ts`). When present this overrides the
     * position-derived line below — the caller-side positions of a
     * global-only subset don't line up with the original file once
     * non-global rows have been filtered out. Absent for callers with no
     * physical source to attribute (e.g. a fresh `exportGlobalRows` roundtrip
     * in tests), which keeps the positional fallback.
     */
    line?: number;
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
 * Decode a SELECTed D1 row back into a doc via the shared {@link decodeGlobalRow}
 * helper — re-exposing `_id` (from the `id` column), preserving `_creationTime`,
 * and reversing every column's storage form (1/0 → boolean, JSON → object/array/
 * record, decimal string → bigint). Falls back to `_id`/`_creationTime`-only
 * when the table isn't declared in the schema.
 */
const decodeRow = (schema: SchemaLike, table: string, row: Record<string, unknown>): Record<string, unknown> => {
    const definition = schema.tables[table];

    if (!definition) {
        return { _creationTime: row["_creationTime"], _id: row["id"] };
    }

    return decodeGlobalRow(definition, row);
};

/**
 * Wire-encode a decoded doc on its way out of this plane.
 *
 * {@link decodeGlobalRow} reverses the storage form, so a `v.bigint()` column
 * comes back as a real `bigint` and a `v.bytes()` column as an `ArrayBuffer` —
 * neither of which survives the `JSON.stringify` every consumer of these rows
 * performs (`JSON.stringify(1n)` throws; an `ArrayBuffer` silently becomes
 * `{}`). The shard plane's rows cross the DO RPC boundary already wire-encoded,
 * so encoding here is what makes the two halves of an NDJSON snapshot the same
 * shape. `needsWireEncoding` keeps a pure-JSON doc allocation-free and
 * byte-identical.
 */
const encodeExportDocument = (document_: Record<string, unknown>): Record<string, unknown> =>
    needsWireEncoding(document_) ? (encodeWire(document_) as Record<string, unknown>) : document_;

interface ExportGlobalArgs {
    batchSize?: number;
    tables?: ReadonlyArray<string>;
}

/**
 * Yield rows from every requested `.global()` table in batches.
 *
 * Keyset-paginates on the physical primary key (`id` — every `.global()` table
 * carries it, see `frameworkColumnDdl`): `WHERE "id" > ? ORDER BY "id" LIMIT ?`,
 * carrying the last id forward. A plain `LIMIT/OFFSET` scan would be wrong here —
 * SQLite gives no ordering guarantee for an unordered SELECT and each page is a
 * separate query, so pages could overlap or skip rows (and any concurrent
 * insert/delete would shift offsets and silently drop/duplicate rows in the
 * snapshot). Keyset paging is deterministic under concurrent writes and avoids
 * O(n^2) OFFSET scans on large tables.
 *
 * Tables are provisioned first (idempotent `CREATE … IF NOT EXISTS`): `.global()`
 * tables are created lazily on first write, so a fresh deployment — or any table
 * never written — would otherwise abort the stream with a raw `no such table`
 * instead of exporting it as empty.
 */
const exportGlobalRows = async function* (exec: D1Exec, schema: SchemaLike, args: ExportGlobalArgs): AsyncGenerator<ExportRow, void, undefined> {
    const tables = selectGlobalTables(schema, args.tables);
    const batchSize = args.batchSize ?? DEFAULT_BATCH_SIZE;

    // Provision the schema's global tables so a never-written table exports as
    // empty rather than throwing `no such table` mid-stream (mirrors the
    // introspector's `ensureGlobalTables`).
    await runD1GlobalTableMigrations(exec, schema);

    for (const table of tables) {
        const quoted = quoteIdentifier(table);
        let lastId: string | undefined;
        let hasMore = true;

        while (hasMore) {
            /* eslint-disable no-await-in-loop -- sequential keyset pagination: each page depends on the prior page's last id */
            const rows =
                lastId === undefined
                    ? await exec.all(`SELECT * FROM ${quoted} ORDER BY "id" LIMIT ?`, [batchSize])
                    : await exec.all(`SELECT * FROM ${quoted} WHERE "id" > ? ORDER BY "id" LIMIT ?`, [lastId, batchSize]);
            /* eslint-enable no-await-in-loop */

            for (const row of rows) {
                yield { doc: encodeExportDocument(decodeRow(schema, table, row)), table };
            }

            const last = rows.at(-1);

            if (last !== undefined) {
                lastId = String(last["id"]);
            }

            hasMore = rows.length === batchSize;
        }
    }
};

/**
 * Structural read of a validator's `.nullable()` flag — `.nullable()` is the one
 * thing that clears `notNull`.
 */
const acceptsNull = (validator: { readonly _meta?: { readonly column?: { readonly notNull?: boolean } } } | undefined): boolean =>
    validator?._meta?.column?.notNull === false;

/**
 * Drop `null`s that mean "this optional field was never set".
 *
 * A `.global()` table stores real columns, so an unset `v.optional(...)` field is
 * a SQL NULL. Snapshots taken before the export decoder learned that (see
 * `nullMeansAbsent` in `@lunora/sql-store`) carry `"field": null` on the wire —
 * and `optional(string).parse(null)` throws, so every row that simply had no
 * value for an optional column was rejected on restore and silently missing from
 * the restored table. Normalised once, here, so both the validation below and the
 * writer see the field as absent, which is what it was.
 *
 * A `.nullable()` column keeps its `null`: there it is a value, not an absence.
 */
const normalizeUnsetOptionals = (definition: SchemaLike["tables"][string], document: Record<string, unknown>): Record<string, unknown> => {
    const unset = new Set<string>();

    for (const [field, validator] of Object.entries(definition.shape)) {
        if (document[field] !== null || validator.kind !== "optional" || acceptsNull(validator)) {
            continue;
        }

        const inner = (validator._meta as { inner?: { readonly _meta?: { readonly column?: { readonly notNull?: boolean } } } } | undefined)?.inner;

        if (!acceptsNull(inner)) {
            unset.add(field);
        }
    }

    return unset.size === 0 ? document : Object.fromEntries(Object.entries(document).filter(([field]) => !unset.has(field)));
};

/** Framework-managed keys a snapshot line legitimately carries alongside the declared fields; re-applied verbatim on insert. */
const FRAMEWORK_FIELDS = new Set(["_creationTime", "_id"]);

/**
 * The first key in `document` the table does not declare, or `undefined`.
 *
 * Reject rather than ignore, exactly as the shard twin does
 * (`@lunora/shard-engine`'s `validateImportRow`). Validation below iterates only
 * `definition.shape` and never looks at an undeclared key, and a `.global()`
 * table stores real columns — so the writer dropped it on the floor and the
 * import still answered 200 with `errors: []`. A snapshot taken before a
 * `title → heading` rename restored as `{"heading": null}` and reported success:
 * the column was gone and nothing said so.
 *
 * `Object.hasOwn`, never `key in shape`: `in` walks the prototype chain, so
 * `constructor`, `toString` and `__proto__` passed as declared fields and then
 * fell out of the column tuple below — the exact "answered 200 and dropped the
 * field" case this guard exists to close, reachable from any snapshot line.
 */
const undeclaredField = (definition: SchemaLike["tables"][string], document: Record<string, unknown>): string | undefined =>
    Object.keys(document).find((key) => !FRAMEWORK_FIELDS.has(key) && !Object.hasOwn(definition.shape, key));

const validateRow = (schema: SchemaLike, table: string, document: Record<string, unknown>): string | undefined => {
    const definition = schema.tables[table];

    if (!definition) {
        return `unknown table: ${table}`;
    }

    const undeclared = undeclaredField(definition, document);

    if (undeclared !== undefined) {
        return `unexpected field "${undeclared}": not declared in table "${table}"`;
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
     * `SELECT 1 FROM <table> WHERE id = ? LIMIT 1` against the row's declared
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

    // A row with no usable `table` is CORRUPT, not "someone else's" — check it
    // before the global/shard routing below. Without this,
    // `schema.tables[undefined]` is `undefined`, `?.shardMode?.kind` is
    // `undefined`, and the row fell into the skip branch: the import reported
    // success with zero errors and the operator could not tell a malformed line
    // from a legitimately shard-local one. The shard-engine twin reports
    // `BAD_ROW` for the identical input.
    if (typeof table !== "string" || table.length === 0) {
        return { error: { code: "BAD_ROW", line, message: "row is missing `table`", table }, kind: "error" };
    }

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

    // Mirror `encodeExportDocument` on the way back in: a snapshot line carries a
    // `v.bigint()` / `v.bytes()` field in its tagged wire form, and both the
    // validators below and the writer's own encoder want the real value.
    // `decodeWire` is the identity on a pure-JSON doc. It throws on a malformed
    // tag (an over-long bigint, nesting past its cap) — that is one bad line in
    // an untrusted snapshot, not a reason to abort the whole import.
    let decoded: Record<string, unknown>;

    try {
        decoded = decodeWire(doc) as Record<string, unknown>;
    } catch (error: unknown) {
        return { error: { code: "BAD_ROW", line, message: error instanceof Error ? error.message : String(error), table }, kind: "error" };
    }

    // Reached only past the global-table check above, so the definition exists.
    decoded = normalizeUnsetOptionals(schema.tables[table], decoded);

    const failure = validateRow(schema, table, decoded);

    if (failure !== undefined) {
        return { error: { code: "VALIDATION_ERROR", line, message: failure, table }, kind: "error" };
    }

    const explicitId = typeof decoded["_id"] === "string" ? decoded["_id"] : undefined;

    if (explicitId !== undefined && (await explicitIdConflicts(writer, args.exec, table, explicitId))) {
        return { kind: "conflict" };
    }

    try {
        // Trusted admin import path: preserve the pinned `_id` from the
        // snapshot (the default insert path now strips client-chosen ids).
        await writer.insert(table, decoded, { allowExplicitId: true });

        return { inserted: table, kind: "inserted" };
    } catch (error: unknown) {
        // Routed through `toErrorBody` (mirrors `@lunora/do`'s twin) rather than
        // the naked `error.message`/`.code` this used to embed directly: a
        // recognized `LunoraError` still surfaces its real code/message, but an
        // internal-coded or unrecognized throw is redacted instead of leaking
        // raw error text into the admin import response.
        const { body } = toErrorBody(error, { fallbackCode: "INSERT_FAILED" });

        return { error: { code: body.code, line, message: body.message, table }, kind: "error" };
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

        // Prefer the row's own true physical line when the caller supplied one
        // (see `ExportRow.line`) — the position-derived `line` above assumes a
        // contiguous run starting at `startLine`, which interspersed global
        // rows (shard-local rows filtered out upstream) violate.
        const effectiveLine = row.line ?? line;

        // eslint-disable-next-line no-await-in-loop -- imports apply row-by-row in input order so per-line error/conflict reporting and the shared writer stay deterministic.
        const outcome = await importOneRow(writer, schema, args, row, effectiveLine);

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
