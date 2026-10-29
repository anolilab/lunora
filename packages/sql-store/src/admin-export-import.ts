/**
 * Admin bulk export/import for `.global()` tables, on any engine the store core
 * drives (D1/SQLite, Postgres, MySQL) — only the paging read and the conflict
 * probe touch SQL, and both render through the engine's {@link SqlDialect}.
 *
 * Twin of `@lunora/do`'s `admin-export-import.ts`, except every read/write is
 * an async exec call (real columns instead of JSON blobs). The worker stitches
 * these globals and per-shard DO output into a single NDJSON stream.
 */

import { toErrorBody } from "@lunora/errors";
import type { DatabaseWriterLike, ImportConflictMode, SchemaLike } from "@lunora/shard-engine";
import { decodeWire, encodeWire, needsWireEncoding } from "@lunora/wire";
import { sql } from "drizzle-orm";

import { runSqlGlobalTableMigrations } from "./ctx-db-global-provisioning";
import type { SqlDialect } from "./dialect";
import type { SqlCtxExec as SqlContextExec } from "./sql-exec";
import { decodeGlobalRow, queryAll, readRowsPage } from "./sql-exec";

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
     * physical source to attribute (e.g. a fresh `exportSqlGlobalRows` roundtrip
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
    /** Skipped rows whose `_id` already exists (the default `onConflict: "skip"`). */
    conflicts: number;
    errors: ImportError[];
    inserted: Record<string, number>;
    /** Existing rows overwritten under `onConflict: "replace"`. */
    replaced: number;
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
 * carries it): `WHERE id > ? ORDER BY id LIMIT n`, carrying the last id forward.
 * A plain `LIMIT/OFFSET` scan would be wrong here — no engine guarantees an
 * order for an unordered SELECT and each page is a separate query, so pages
 * could overlap or skip rows (and any concurrent insert/delete would shift
 * offsets and silently drop/duplicate rows in the snapshot). Keyset paging is
 * deterministic under concurrent writes and avoids O(n^2) OFFSET scans.
 *
 * Tables are provisioned first (idempotent `CREATE … IF NOT EXISTS`): `.global()`
 * tables are created lazily on first write, so a fresh deployment — or any table
 * never written — would otherwise abort the stream with a raw `no such table`
 * instead of exporting it as empty.
 */
const exportSqlGlobalRows = async function* (
    exec: SqlContextExec,
    schema: SchemaLike,
    dialect: SqlDialect,
    args: ExportGlobalArgs,
): AsyncGenerator<ExportRow, void, undefined> {
    const tables = selectGlobalTables(schema, args.tables);
    const batchSize = args.batchSize ?? DEFAULT_BATCH_SIZE;

    // Provision the schema's global tables so a never-written table exports as
    // empty rather than throwing `no such table` mid-stream (mirrors the
    // introspector's `ensureGlobalTables`).
    await runSqlGlobalTableMigrations(exec, schema, dialect);

    for (const table of tables) {
        // `selectGlobalTables` only returns tables the schema declares.
        const definition = schema.tables[table] as SchemaLike["tables"][string];
        let lastId: string | undefined;
        let hasMore = true;

        while (hasMore) {
            // eslint-disable-next-line no-await-in-loop -- sequential keyset pagination: each page depends on the prior page's last id
            const rows = await readRowsPage(exec, dialect, table, lastId, batchSize);

            for (const row of rows) {
                yield { doc: encodeExportDocument(decodeGlobalRow(definition, row)), table };
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

        const inner = validator._meta?.inner;

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
 * `Object.hasOwn` rather than `in`: `in` walks the prototype chain, so a snapshot
 * key named `constructor`/`toString`/`valueOf` read as declared. The validation
 * loop below iterates `Object.entries(definition.shape)` and never sees such a
 * key, so it reached `writer.insert` unvalidated — the exact case this guard
 * exists to close.
 */
const undeclaredField = (definition: SchemaLike["tables"][string], document: Record<string, unknown>): string | undefined =>
    Object.keys(document).find((key) => !FRAMEWORK_FIELDS.has(key) && !Object.hasOwn(definition.shape, key));

/**
 * A present system field the writer cannot use would be dropped and regenerated, silently giving a restored row a new
 * identity, so it is a row error in the dry run and the write alike.
 */
const systemFieldError = (document: Record<string, unknown>): string | undefined => {
    const id = document["_id"];
    const creationTime = document["_creationTime"];

    if (id !== undefined && (typeof id !== "string" || id === "")) {
        return 'field "_id": must be a non-empty string';
    }

    if (creationTime !== undefined && (typeof creationTime !== "number" || !Number.isFinite(creationTime))) {
        return 'field "_creationTime": must be a finite number';
    }

    return undefined;
};

const validateRow = (schema: SchemaLike, table: string, document: Record<string, unknown>): string | undefined => {
    const definition = schema.tables[table];

    if (!definition) {
        return `unknown table: ${table}`;
    }

    const undeclared = undeclaredField(definition, document);

    if (undeclared !== undefined) {
        return `unexpected field "${undeclared}": not declared in table "${table}"`;
    }

    const systemField = systemFieldError(document);

    if (systemField !== undefined) {
        return systemField;
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
     * Check the rows and report their shape errors, writing nothing. The conflict
     * probe and the insert are skipped, so an `_id` already in use and a foreign-key
     * or unique failure are only found by a real import.
     */
    dryRun?: boolean;

    /**
     * Optional direct exec handle to the same database the writer targets.
     * When supplied, the conflict pre-probe issues a single
     * `SELECT 1 FROM <table> WHERE id = ? LIMIT 1` against the row's declared
     * table instead of falling back to an unscoped id probe, which scans every
     * global table looking for the id. Strongly recommended for large schemas
     * — the writer-fallback is O(N tables) per row.
     */
    exec?: SqlContextExec;

    /**
     * What a row whose `_id` already exists in its table does: `"skip"` (the
     * default) counts it as a conflict and leaves the stored row unchanged;
     * `"replace"` overwrites the stored row with the snapshot's fields, keeping
     * its `_id` and taking the snapshot's `_creationTime`. A dry run probes
     * nothing, so the mode does not change its answer.
     */
    onConflict?: ImportConflictMode;
    rows: ReadonlyArray<ExportRow>;
    startLine?: number;
}

/** Tables per ownership probe: one bound id each, kept well under D1's 100-parameter ceiling. */
const OWNER_PROBE_TABLES = 50;

/**
 * The `.global()` table that already holds `explicitId`, or `undefined` when the
 * id is free. `table` itself comes first, so a conflict in the row's own table
 * wins over a collision. Any other name is a cross-table collision: an id-only
 * `get`/`patch`/`delete` resolves by probing every global table, so a second
 * table holding the same id would make that resolution ambiguous.
 *
 * With an exec handle the tables are asked in one `UNION ALL` round trip, not
 * one each. A probe error propagates: read as "absent", it would let the insert
 * land an id another table holds. The importer provisions every global table
 * before the first probe, so a table that was never written is not an error.
 */
const explicitIdOwner = async (
    writer: DatabaseWriterLike,
    schema: SchemaLike,
    dialect: SqlDialect,
    exec: ImportGlobalArgs["exec"],
    table: string,
    explicitId: string,
): Promise<string | undefined> => {
    const others = Object.keys(schema.tables).filter((name) => name !== table && schema.tables[name]?.shardMode?.kind === "global");
    const candidates = [table, ...others];

    for (let start = 0; start < candidates.length; start += OWNER_PROBE_TABLES) {
        const chunk = candidates.slice(start, start + OWNER_PROBE_TABLES);

        if (!exec) {
            for (const candidate of chunk) {
                // eslint-disable-next-line no-await-in-loop -- probed in order so the row's own table answers first, and the scan stops at the first owner
                if ((await writer.get(candidate, explicitId)) !== null) {
                    return candidate;
                }
            }

            continue;
        }

        const selects = chunk.map(
            (candidate, index) => sql`SELECT ${sql.raw(String(index))} AS slot FROM ${sql.identifier(candidate)} WHERE ${sql.identifier("id")} = ${explicitId}`,
        );
        // eslint-disable-next-line no-await-in-loop -- chunks are asked in order so the row's own table answers first
        const hits = await queryAll(exec, dialect, sql`${sql.join(selects, sql` UNION ALL `)} ORDER BY slot LIMIT 1`);
        const slot = hits[0]?.["slot"];

        if (slot !== undefined) {
            return chunk[Number(slot)];
        }
    }

    return undefined;
};

/**
 * `explicitId` when the row's own table already holds it (a conflict, or the
 * row a replace overwrites), `undefined` when it is free, or the row error when
 * another table holds it or the probe failed.
 */
const ownIdOrError = async (
    writer: DatabaseWriterLike,
    schema: SchemaLike,
    dialect: SqlDialect,
    exec: ImportGlobalArgs["exec"],
    table: string,
    explicitId: string,
    line: number,
): Promise<{ error: ImportError } | { existingId: string | undefined }> => {
    let owner: string | undefined;

    try {
        owner = await explicitIdOwner(writer, schema, dialect, exec, table, explicitId);
    } catch (error: unknown) {
        const { body } = toErrorBody(error, { fallbackCode: "PROBE_FAILED" });

        return { error: { code: body.code, line, message: body.message, table } };
    }

    if (owner !== undefined && owner !== table) {
        return { error: { code: "ID_COLLISION", line, message: `_id "${explicitId}" already belongs to table "${owner}"`, table } };
    }

    return { existingId: owner === table ? explicitId : undefined };
};

type RowOutcome =
    | { error: ImportError; kind: "error" }
    | { inserted: string; kind: "inserted" }
    | { kind: "checked" }
    | { kind: "conflict" }
    | { kind: "replaced" }
    | { kind: "skip" };

/**
 * Insert `document`, or — when `existingId` names the row it collides with —
 * overwrite that row. `replace` takes the id as its own argument; the
 * trusted-replay `allowExplicitId` is what lets the snapshot's `_creationTime`
 * stand on a replace and its `_id` on an insert (the default insert path strips
 * client-chosen ids).
 */
const writeRow = async (
    writer: DatabaseWriterLike,
    table: string,
    document: Record<string, unknown>,
    existingId: string | undefined,
    line: number,
): Promise<RowOutcome> => {
    try {
        if (existingId !== undefined) {
            const fields = { ...document };

            delete fields["_id"];

            await writer.replace(table, existingId, fields, { allowExplicitId: true });

            return { kind: "replaced" };
        }

        await writer.insert(table, document, { allowExplicitId: true });

        return { inserted: table, kind: "inserted" };
    } catch (error: unknown) {
        // Routed through `toErrorBody` (mirrors `@lunora/do`'s twin) rather than
        // the naked `error.message`/`.code`: a recognized `LunoraError` still
        // surfaces its real code/message, but an internal-coded or unrecognized
        // throw is redacted instead of leaking raw error text into the admin
        // import response.
        const { body } = toErrorBody(error, { fallbackCode: existingId === undefined ? "INSERT_FAILED" : "REPLACE_FAILED" });

        return { error: { code: body.code, line, message: body.message, table }, kind: "error" };
    }
};

/** Resolve one import row to a single outcome, isolating the per-row branching from the accumulation loop. */
const importOneRow = async (
    writer: DatabaseWriterLike,
    schema: SchemaLike,
    dialect: SqlDialect,
    args: ImportGlobalArgs,
    row: ExportRow,
    line: number,
): Promise<RowOutcome> => {
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

    // A dry run stops at the shape: the conflict probe and the insert are what it must not do.
    if (args.dryRun === true) {
        return { kind: "checked" };
    }

    const explicitId = typeof decoded["_id"] === "string" ? decoded["_id"] : undefined;
    const ownership = explicitId === undefined ? { existingId: undefined } : await ownIdOrError(writer, schema, dialect, args.exec, table, explicitId, line);

    if ("error" in ownership) {
        return { error: ownership.error, kind: "error" };
    }

    const { existingId } = ownership;

    if (existingId !== undefined && args.onConflict !== "replace") {
        return { kind: "conflict" };
    }

    return writeRow(writer, table, decoded, existingId, line);
};

/**
 * Import rows into `.global()` tables via the schema-aware writer. The
 * writer rejects unknown ids on `insert` (the writer assigns one when `_id` is
 * absent); we pre-probe each row's `_id` so a collision is reported as a
 * conflict instead of bubbled as a UNIQUE error. Schema-failed rows surface in
 * `errors`; the rest land.
 */
const importSqlGlobalRows = async (writer: DatabaseWriterLike, schema: SchemaLike, dialect: SqlDialect, args: ImportGlobalArgs): Promise<ImportResult> => {
    const errors: ImportError[] = [];
    const inserted: Record<string, number> = {};
    let conflicts = 0;
    let replaced = 0;
    let line = (args.startLine ?? 1) - 1;

    // The ownership probe reads every global table, so each must exist first. A dry run touches no table.
    if (args.exec && args.dryRun !== true) {
        await runSqlGlobalTableMigrations(args.exec, schema, dialect);
    }

    for (const row of args.rows) {
        line += 1;

        // Prefer the row's own true physical line when the caller supplied one
        // (see `ExportRow.line`) — the position-derived `line` above assumes a
        // contiguous run starting at `startLine`, which interspersed global
        // rows (shard-local rows filtered out upstream) violate.
        const effectiveLine = row.line ?? line;

        // eslint-disable-next-line no-await-in-loop -- imports apply row-by-row in input order so per-line error/conflict reporting and the shared writer stay deterministic.
        const outcome = await importOneRow(writer, schema, dialect, args, row, effectiveLine);

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

            case "replaced": {
                replaced += 1;
                break;
            }

            default: {
                break;
            }
        }
    }

    return { conflicts, errors, inserted, replaced };
};

export { exportSqlGlobalRows, importSqlGlobalRows, selectGlobalTables };
export type { ExportGlobalArgs, ExportRow, ImportError, ImportGlobalArgs, ImportResult };
