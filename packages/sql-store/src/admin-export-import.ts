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
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { runSqlGlobalTableMigrations } from "./ctx-db-global-provisioning";
import type { SqlDialect } from "./dialect";
import { takePostCommitError } from "./post-commit-error";
import type { SqlCtxExec as SqlContextExec } from "./sql-exec";
import { decodeGlobalRow, MAX_BOUND_PARAMETERS, queryAll, readRowsPage } from "./sql-exec";

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
     * Optional direct exec handle to the same database the writer targets. When supplied, the conflict probe
     * is a batched `SELECT id ... WHERE id IN (...)` per table (or, for a schema with triggers, one
     * `SELECT 1 ... WHERE id = ?` per row) instead of a writer `get` per row.
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

/**
 * Whether `table` itself holds `id`. Only the row's own table is asked: the writer pins every by-id call to its
 * table, so the same `_id` in another global table is not a hazard.
 *
 * Without an exec handle the writer's own `get` answers; with one, a single indexed `SELECT 1`. A probe error
 * propagates: read as "absent", it would let the insert overwrite or duplicate a row that is there. The importer
 * provisions every global table before the first probe, so a table that was never written is not an error.
 */
const tableHolds = async (writer: DatabaseWriterLike, dialect: SqlDialect, exec: ImportGlobalArgs["exec"], table: string, id: string): Promise<boolean> => {
    if (!exec) {
        return (await writer.get(table, id)) !== null;
    }

    const hits = await queryAll(exec, dialect, sql`SELECT 1 FROM ${sql.identifier(table)} WHERE ${sql.identifier("id")} = ${id} LIMIT 1`);

    return hits.length > 0;
};

/**
 * `explicitId` when the row's own table holds it (a conflict, or the row a replace overwrites), `undefined` when
 * it is free, or the row error when the probe failed.
 */
const probeOwnTable = async (
    writer: DatabaseWriterLike,
    dialect: SqlDialect,
    exec: ImportGlobalArgs["exec"],
    table: string,
    explicitId: string,
    line: number,
): Promise<{ error: ImportError } | { existingId: string | undefined }> => {
    try {
        return { existingId: (await tableHolds(writer, dialect, exec, table, explicitId)) ? explicitId : undefined };
    } catch (error: unknown) {
        const { body } = toErrorBody(error, { fallbackCode: "PROBE_FAILED" });

        return { error: { code: body.code, line, message: body.message, table } };
    }
};

/** What the batched probe learned: the ids each table holds, or the error that stopped it. */
type HeldIds = { failure: { code: string; message: string } } | { held: Map<string, Set<string>> };

const recordHeld = (found: { held: Map<string, Set<string>> }, table: string, id: string): void => {
    const ids = found.held.get(table) ?? new Set<string>();

    ids.add(id);
    found.held.set(table, ids);
};

/**
 * Ask each table which of its own rows' ids it already holds, in as few statements as the parameter ceiling
 * allows. A statement is a `UNION ALL` of per-table branches `SELECT <slot>, id FROM <table> WHERE id IN (...)`
 * and binds at most {@link MAX_BOUND_PARAMETERS} ids across all its branches (D1's per-statement limit), so the
 * cost is about `ids / 100` round trips rather than one per row. The slot is the table's index, inlined because
 * it is not a parameter.
 *
 * Fails closed: if any statement throws, nothing is known and the whole result is the failure. Reading
 * "unknown" as "free" would let an insert land on an id that is taken.
 *
 * A snapshot: it is only valid while nothing but this import writes. A write that runs user code (a trigger)
 * can create or delete rows in these tables mid-import, so {@link hasGlobalTriggers} schemas probe per row.
 */
const probeHeldIds = async (exec: SqlContextExec, dialect: SqlDialect, idsByTable: ReadonlyMap<string, ReadonlySet<string>>): Promise<HeldIds> => {
    const tables = [...idsByTable.keys()];
    const held = new Map<string, Set<string>>();
    let branches: SQL[] = [];
    let budget = MAX_BOUND_PARAMETERS;

    const flush = async (): Promise<void> => {
        if (branches.length === 0) {
            return;
        }

        const hits = await queryAll(exec, dialect, sql.join(branches, sql` UNION ALL `));

        for (const hit of hits) {
            recordHeld({ held }, tables[Number(hit["slot"])] as string, String(hit["id"]));
        }

        branches = [];
        budget = MAX_BOUND_PARAMETERS;
    };

    try {
        for (const [slot, table] of tables.entries()) {
            const ids = [...(idsByTable.get(table) as ReadonlySet<string>)];

            for (let start = 0; start < ids.length;) {
                const taken = ids.slice(start, start + budget);

                branches.push(
                    sql`SELECT ${sql.raw(String(slot))} AS slot, ${sql.identifier("id")} FROM ${sql.identifier(table)} WHERE ${sql.identifier("id")} IN (${sql.join(
                        taken.map((id) => sql.param(id)),
                        sql`, `,
                    )})`,
                );
                start += taken.length;
                budget -= taken.length;

                if (budget === 0) {
                    // eslint-disable-next-line no-await-in-loop -- statements run one at a time so a large import never fans out concurrent subrequests
                    await flush();
                }
            }
        }

        await flush();
    } catch (error: unknown) {
        const { body } = toErrorBody(error, { fallbackCode: "PROBE_FAILED" });

        return { failure: { code: body.code, message: body.message } };
    }

    return { held };
};

/** The batched probe answered for one row. */
const heldOwnership = (found: HeldIds, table: string, explicitId: string, line: number): { error: ImportError } | { existingId: string | undefined } => {
    if ("failure" in found) {
        return { error: { ...found.failure, line, table } };
    }

    return { existingId: found.held.get(table)?.has(explicitId) === true ? explicitId : undefined };
};

/**
 * Whether any `.global()` table runs user code on a write. A trigger can create or delete rows in a table
 * mid-import, which stales a snapshot taken before the first row.
 */
const hasGlobalTriggers = (schema: SchemaLike): boolean =>
    selectGlobalTables(schema).some((table) => Object.keys(schema.tables[table]?.triggerMap ?? {}).length > 0);

type RowOutcome =
    | { committed: boolean; error: ImportError; kind: "error" }
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
    onConflict: ImportGlobalArgs["onConflict"],
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

        // A failure after the base row committed leaves it stored: the caller must not read a unique violation from
        // a trigger's or companion's own write as the row's `_id` being taken, nor write the row a second time.
        const committedId = existingId ?? (typeof document["_id"] === "string" ? document["_id"] : undefined);
        const committed = committedId !== undefined && takePostCommitError(error, table, committedId);

        // Say what is known: the base row committed, and the work after it did not finish. Not that the row is still
        // there (its own trigger may have deleted it before throwing), and advice that matches the conflict mode: a
        // skip-mode re-import skips a row that still exists, so the failed work is redone only under "replace".
        const advice =
            onConflict === "replace"
                ? 're-importing it with onConflict "replace" redoes that work'
                : 'a re-import skips it while it exists; use onConflict "replace" to redo that work';
        const message = committed
            ? `${body.message} (row "${committedId}" committed before this failure, so its triggers or companion writes may not have completed; ${advice})`
            : body.message;

        return { committed, error: { code: body.code, line, message, table }, kind: "error" };
    }
};

type ReadyRow = { decoded: Record<string, unknown>; explicitId: string | undefined; kind: "ready"; line: number; table: string };
type PreparedRow = ReadyRow | { kind: "settled"; outcome: RowOutcome };

/**
 * Check one import row without touching the database: routing, shape, decoding,
 * validation and the dry-run stop. A row settled here costs no query, which is
 * what lets the ownership probe cover only rows that will really be written.
 */
const prepareRow = (schema: SchemaLike, dryRun: boolean, row: ExportRow, line: number): PreparedRow => {
    const { doc, table } = row;

    // A row with no usable `table` is CORRUPT, not "someone else's" — check it
    // before the global/shard routing below. Without this,
    // `schema.tables[undefined]` is `undefined`, `?.shardMode?.kind` is
    // `undefined`, and the row fell into the skip branch: the import reported
    // success with zero errors and the operator could not tell a malformed line
    // from a legitimately shard-local one. The shard-engine twin reports
    // `BAD_ROW` for the identical input.
    if (typeof table !== "string" || table.length === 0) {
        return { kind: "settled", outcome: { committed: false, error: { code: "BAD_ROW", line, message: "row is missing `table`", table }, kind: "error" } };
    }

    // Only process globals here; shard-local rows are someone else's
    // responsibility (the DO importers handle those).
    if (schema.tables[table]?.shardMode?.kind !== "global") {
        return { kind: "settled", outcome: { kind: "skip" } };
    }

    // Defensive against untrusted snapshot rows: `doc` is typed non-null, but
    // an import payload can carry a missing/malformed `doc` off the wire.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- guard on untrusted parsed NDJSON, not on the declared type
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
        return {
            kind: "settled",
            outcome: { committed: false, error: { code: "BAD_ROW", line, message: "row is missing or malformed `doc`", table }, kind: "error" },
        };
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
        return {
            kind: "settled",
            outcome: {
                committed: false,
                error: { code: "BAD_ROW", line, message: error instanceof Error ? error.message : String(error), table },
                kind: "error",
            },
        };
    }

    // Reached only past the global-table check above, so the definition exists.
    decoded = normalizeUnsetOptionals(schema.tables[table], decoded);

    const failure = validateRow(schema, table, decoded);

    if (failure !== undefined) {
        return { kind: "settled", outcome: { committed: false, error: { code: "VALIDATION_ERROR", line, message: failure, table }, kind: "error" } };
    }

    // A dry run stops at the shape: the conflict probe and the insert are what it must not do.
    if (dryRun) {
        return { kind: "settled", outcome: { kind: "checked" } };
    }

    return { decoded, explicitId: typeof decoded["_id"] === "string" ? decoded["_id"] : undefined, kind: "ready", line, table };
};

/**
 * How a row learns whether its own table already holds its `_id`: from the batched snapshot, or by asking the
 * table right before the write.
 */
interface OwnershipSource {
    /** The batched snapshot; absent when each row is probed immediately before its write. */
    snapshot?: HeldIds;
}

/**
 * Re-ask the row's own table after an explicit-id insert failed with a unique violation: a concurrent writer may
 * have created the id since it was last probed, and that is a conflict, not an insert failure. A probe that throws
 * or finds nothing leaves the original insert error standing (the violation was on another unique index).
 */
const recheckOwnTable = async (
    writer: DatabaseWriterLike,
    dialect: SqlDialect,
    exec: ImportGlobalArgs["exec"],
    source: OwnershipSource,
    row: ReadyRow & { explicitId: string },
    onConflict: ImportGlobalArgs["onConflict"],
): Promise<RowOutcome | undefined> => {
    const { decoded, explicitId, line, table } = row;

    try {
        if (!(await tableHolds(writer, dialect, exec, table, explicitId))) {
            return undefined;
        }
    } catch {
        return undefined;
    }

    if (source.snapshot !== undefined && "held" in source.snapshot) {
        recordHeld(source.snapshot, table, explicitId);
    }

    // The row appeared in its own table after it was probed: under replace it is the row to overwrite.
    return onConflict === "replace" ? writeRow(writer, table, decoded, explicitId, line, onConflict) : { kind: "conflict" };
};

/** Resolve one prepared import row to a single outcome, isolating the per-row branching from the accumulation loop. */
const importOneRow = async (
    writer: DatabaseWriterLike,
    dialect: SqlDialect,
    args: ImportGlobalArgs,
    row: ReadyRow,
    source: OwnershipSource,
): Promise<RowOutcome> => {
    const { decoded, explicitId, line, table } = row;
    let ownership: { error: ImportError } | { existingId: string | undefined } = { existingId: undefined };

    if (explicitId !== undefined) {
        ownership =
            source.snapshot === undefined
                ? await probeOwnTable(writer, dialect, args.exec, table, explicitId, line)
                : heldOwnership(source.snapshot, table, explicitId, line);
    }

    if ("error" in ownership) {
        return { committed: false, error: ownership.error, kind: "error" };
    }

    const { existingId } = ownership;

    if (existingId !== undefined && args.onConflict !== "replace") {
        return { kind: "conflict" };
    }

    const outcome = await writeRow(writer, table, decoded, existingId, line, args.onConflict);

    if (explicitId === undefined) {
        return outcome;
    }

    const { snapshot } = source;

    if (
        snapshot !== undefined &&
        "held" in snapshot &&
        (outcome.kind === "inserted" || outcome.kind === "replaced" || (outcome.kind === "error" && outcome.committed))
    ) {
        // The snapshot predates this write: record it so a later row repeating the id is seen, including when only the
        // row's trigger or companion write failed after the row itself was stored.
        recordHeld(snapshot, table, explicitId);
    }

    if (outcome.kind === "error" && !outcome.committed && outcome.error.code === "CONFLICT" && existingId === undefined) {
        // A unique violation of the row's own write (nothing committed) can mean the id was taken since it was probed.
        return (await recheckOwnTable(writer, dialect, args.exec, source, { ...row, explicitId }, args.onConflict)) ?? outcome;
    }

    return outcome;
};

/**
 * Prepare the ownership probe for every explicit id in `prepared`: provision the tables, then, when `batched`,
 * snapshot which ids each row's own table holds. Without `batched` (a schema with triggers) the rows are probed one
 * at a time right before their write, so only provisioning happens here and a snapshot is not returned.
 *
 * Provisioning runs only when there is something to probe, and its failure is a probe failure: the rows error out
 * rather than the whole import rejecting.
 */
const probeBatch = async (
    exec: SqlContextExec,
    schema: SchemaLike,
    dialect: SqlDialect,
    prepared: ReadonlyArray<PreparedRow>,
    batched: boolean,
): Promise<HeldIds | undefined> => {
    const idsByTable = new Map<string, Set<string>>();

    for (const entry of prepared) {
        if (entry.kind === "ready" && entry.explicitId !== undefined) {
            const ids = idsByTable.get(entry.table) ?? new Set<string>();

            ids.add(entry.explicitId);
            idsByTable.set(entry.table, ids);
        }
    }

    if (idsByTable.size === 0) {
        return batched ? { held: new Map() } : undefined;
    }

    try {
        await runSqlGlobalTableMigrations(exec, schema, dialect);
    } catch (error: unknown) {
        const { body } = toErrorBody(error, { fallbackCode: "PROBE_FAILED" });

        return { failure: { code: body.code, message: body.message } };
    }

    return batched ? probeHeldIds(exec, dialect, idsByTable) : undefined;
};

/**
 * Import rows into `.global()` tables via the schema-aware writer. The
 * writer rejects unknown ids on `insert` (the writer assigns one when `_id` is
 * absent); we probe the rows' `_id`s first so a collision is reported as a
 * conflict instead of bubbled as a UNIQUE error. Schema-failed rows surface in
 * `errors`; the rest land.
 *
 * Only a row's own table is probed. With an `exec` handle and no triggers the probe is batched
 * ({@link probeHeldIds}) once for the whole call; a schema with triggers probes each row right before its write,
 * because a trigger can create or delete rows in the table mid-import.
 */
const importSqlGlobalRows = async (writer: DatabaseWriterLike, schema: SchemaLike, dialect: SqlDialect, args: ImportGlobalArgs): Promise<ImportResult> => {
    const errors: ImportError[] = [];
    const inserted: Record<string, number> = {};
    let conflicts = 0;
    let replaced = 0;
    let line = (args.startLine ?? 1) - 1;
    const prepared = args.rows.map((row): PreparedRow => {
        line += 1;

        // Prefer the row's own true physical line when the caller supplied one
        // (see `ExportRow.line`) — the position-derived `line` above assumes a
        // contiguous run starting at `startLine`, which interspersed global
        // rows (shard-local rows filtered out upstream) violate.
        return prepareRow(schema, args.dryRun === true, row, row.line ?? line);
    });
    const source: OwnershipSource = {};

    // The probe reads the rows' tables, so each must exist first. A dry run touches no table. A schema whose writes
    // can run user code is probed per row instead of from a snapshot (see `probeHeldIds`).
    if (args.exec && args.dryRun !== true) {
        source.snapshot = await probeBatch(args.exec, schema, dialect, prepared, !hasGlobalTriggers(schema));
    }

    for (const entry of prepared) {
        // eslint-disable-next-line no-await-in-loop -- imports apply row-by-row in input order so per-line error/conflict reporting and the shared writer stay deterministic.
        const outcome = entry.kind === "settled" ? entry.outcome : await importOneRow(writer, dialect, args, entry, source);

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
