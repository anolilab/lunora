/**
 * The `.global()` (D1) half of a staged replace import (`@lunora/runtime`'s
 * `import-session.ts`).
 *
 * Rows are validated as they are staged — a row that would not land fails the
 * staging request, before any commit — and wait in `__lunora_import_stage__`.
 * The commit writes them through the schema-aware writer (so the CDC log and the
 * search / aggregate / rank companions follow) and then prunes every row of the
 * replaced tables the snapshot does not hold.
 *
 * **Not atomic.** D1 has no interactive transaction, and `batch()` is atomic only
 * over a statement list fixed up front — which the writer, reading as it writes
 * (id probes, companion upkeep, cascades), cannot produce. What the commit
 * guarantees instead: nothing is written before every staged row validated;
 * writes go first and the prune runs only once every write landed, so a failure
 * part-way leaves the old rows plus some snapshot rows — never fewer rows than
 * either side; and the staged rows are dropped only together with the
 * `committed` marker (one `batch()`), so a retried commit re-applies them
 * (overwrite and prune are idempotent) or, once committed, answers the recorded
 * result.
 */
import type { DatabaseWriterLike, SchemaLike } from "@lunora/shard-engine";

import { decodeWire, encodeWire } from "../../../shared/wire-codec";
import type { ExportRow, ImportError, ImportResult } from "./admin-export-import";
import { explicitIdConflicts, prepareReplaceRows, writeRow } from "./admin-export-import";
import type { D1Exec } from "./d1-ctx-db";
import { quoteIdentifier } from "./dialect";

const STAGE_TABLE = "__lunora_import_stage__";
const SESSION_TABLE = "__lunora_import_session__";

/** How long a staged session lives after it was last touched — the shard twin's TTL. */
const STAGE_TTL_MS: number = 24 * 60 * 60 * 1000;

const PAGE_ROWS = 200;

/** A staged-replace failure the caller maps to its HTTP status. */
class GlobalImportStagingError extends Error {
    public readonly code: string;

    public constructor(code: string, message: string) {
        super(message);
        this.name = "GlobalImportStagingError";
        this.code = code;
    }
}

const ensureStaging = async (exec: D1Exec): Promise<void> => {
    await exec.run(
        `CREATE TABLE IF NOT EXISTS "${STAGE_TABLE}" (seq INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, tbl TEXT NOT NULL, id TEXT NOT NULL, line INTEGER NOT NULL, doc TEXT NOT NULL)`,
        [],
    );
    await exec.run(`CREATE INDEX IF NOT EXISTS "${STAGE_TABLE}_by_session" ON "${STAGE_TABLE}" (session, tbl, id)`, []);
    await exec.run(
        `CREATE TABLE IF NOT EXISTS "${SESSION_TABLE}" (session TEXT PRIMARY KEY, state TEXT NOT NULL, generation TEXT NOT NULL, expires_at INTEGER NOT NULL, result TEXT)`,
        [],
    );
};

/** Drop expired sessions in a state this module knows, and their staged rows. A row in any other state is never swept. */
const sweep = async (exec: D1Exec, now: number): Promise<void> => {
    await ensureStaging(exec);
    await exec.run(
        `DELETE FROM "${STAGE_TABLE}" WHERE session IN (SELECT session FROM "${SESSION_TABLE}" WHERE expires_at < ? AND state IN ('staging', 'committed'))`,
        [now],
    );
    await exec.run(`DELETE FROM "${SESSION_TABLE}" WHERE expires_at < ? AND state IN ('staging', 'committed')`, [now]);
};

interface SessionRecord {
    generation: string;
    result?: ImportResult;
    state: "committed" | "staging";
}

/** The session's record, refused when it belongs to another generation or is in a state this module cannot read. */
const readSession = async (exec: D1Exec, session: string, generation: string): Promise<SessionRecord | undefined> => {
    const [row] = await exec.all(`SELECT state, generation, result FROM "${SESSION_TABLE}" WHERE session = ?`, [session]);

    if (row === undefined) {
        return undefined;
    }

    const state = String(row["state"]);

    if (state !== "staging" && state !== "committed") {
        throw new GlobalImportStagingError("IMPORT_SESSION_CORRUPT", `import session "${session}" has an unreadable state in D1`);
    }

    if (String(row["generation"]) !== generation) {
        throw new GlobalImportStagingError("IMPORT_SESSION_STALE", `import session "${session}" in D1 belongs to an earlier session of the same id`);
    }

    return typeof row["result"] === "string" ? { generation, result: JSON.parse(row["result"]) as ImportResult, state } : { generation, state };
};

/** Run `statements` as one D1 round trip when the exec can batch, one at a time otherwise. */
const runAll = async (exec: D1Exec, statements: ReadonlyArray<{ params: ReadonlyArray<unknown>; sql: string }>): Promise<void> => {
    if (exec.batch) {
        await exec.batch(statements);

        return;
    }

    for (const { params, sql } of statements) {
        // eslint-disable-next-line no-await-in-loop -- the no-batch fallback runs in order
        await exec.run(sql, params);
    }
};

interface StageGlobalArgs {
    /** The session's generation (see `@lunora/shard-engine`'s `import-staging`): rows of another one are refused. */
    generation: string;
    rows: ReadonlyArray<ExportRow>;
    session: string;
    startLine?: number;
    /** The session's `.global()` replace scope. */
    tables: ReadonlyArray<string>;
}

/**
 * Validate and stage one request's `.global()` rows. Any refused row stages none
 * of them — the session is then never committed.
 */
const stageGlobalRows = async (
    exec: D1Exec,
    schema: SchemaLike,
    args: StageGlobalArgs,
    now: number = Date.now(),
): Promise<{ errors: ImportError[]; staged: Record<string, number> }> => {
    await sweep(exec, now);

    const record = await readSession(exec, args.session, args.generation);

    if (record?.state === "committed") {
        throw new GlobalImportStagingError("IMPORT_SESSION_COMMITTED", `import session "${args.session}" is already committed`);
    }

    const scope = new Set(args.tables.filter((table) => schema.tables[table]?.shardMode?.kind === "global"));
    const { errors, ready } = prepareReplaceRows(schema, args, scope);

    if (errors.length > 0) {
        return { errors, staged: {} };
    }

    const staged: Record<string, number> = {};

    await runAll(exec, [
        {
            params: [args.session, args.generation, now + STAGE_TTL_MS],
            sql: `INSERT INTO "${SESSION_TABLE}" (session, state, generation, expires_at) VALUES (?, 'staging', ?, ?) ON CONFLICT (session) DO UPDATE SET expires_at = excluded.expires_at`,
        },
        ...ready.map(({ decoded, id, line, table }) => {
            staged[table] = (staged[table] ?? 0) + 1;

            return {
                params: [args.session, table, id, line, JSON.stringify(encodeWire(decoded))],
                sql: `INSERT INTO "${STAGE_TABLE}" (session, tbl, id, line, doc) VALUES (?, ?, ?, ?, ?)`,
            };
        }),
    ]);

    return { errors: [], staged };
};

/** Overwrite-or-insert every staged row, in staging order. Stops at the first page with an error. */
const writeStaged = async (writer: DatabaseWriterLike, exec: D1Exec, session: string): Promise<{ errors: ImportError[]; inserted: Record<string, number> }> => {
    const inserted: Record<string, number> = {};
    let afterSeq = 0;

    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- keyset pagination over the staged rows
        const page = await exec.all(`SELECT seq, tbl, id, line, doc FROM "${STAGE_TABLE}" WHERE session = ? AND seq > ? ORDER BY seq LIMIT ?`, [
            session,
            afterSeq,
            PAGE_ROWS,
        ]);
        const errors: ImportError[] = [];

        for (const row of page) {
            const table = String(row["tbl"]);
            const id = String(row["id"]);
            const decoded = decodeWire(JSON.parse(String(row["doc"]))) as Record<string, unknown>;
            // eslint-disable-next-line no-await-in-loop -- rows are written in staging order through the one writer
            const exists = await explicitIdConflicts(writer, exec, table, id);
            // eslint-disable-next-line no-await-in-loop -- as above
            const outcome = await writeRow(table, Number(row["line"]), async () =>
                exists ? writer.replace(id, decoded, table, { allowExplicitId: true }) : writer.insert(table, decoded, { allowExplicitId: true }),
            );

            if (outcome.kind === "error") {
                errors.push(outcome.error);
            } else {
                inserted[table] = (inserted[table] ?? 0) + 1;
            }
        }

        if (errors.length > 0 || page.length < PAGE_ROWS) {
            return { errors, inserted };
        }

        afterSeq = Number(page.at(-1)?.["seq"]);
    }
};

/** Hard-delete every row of `table` the session did not stage. An absent table (never written) holds none. */
const pruneTable = async (writer: DatabaseWriterLike, exec: D1Exec, session: string, table: string): Promise<number> => {
    const present = await exec.all(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]);

    if (present.length === 0) {
        return 0;
    }

    let deleted = 0;

    for (;;) {
        // Each page is re-read after its deletes, so the anti-join never pages over rows it removed.
        // eslint-disable-next-line no-await-in-loop -- delete page by page through the one writer
        const doomed = await exec.all(
            `SELECT "id" FROM ${quoteIdentifier(table)} WHERE "id" NOT IN (SELECT id FROM "${STAGE_TABLE}" WHERE session = ? AND tbl = ?) LIMIT ?`,
            [session, table, PAGE_ROWS],
        );

        for (const { id } of doomed) {
            // eslint-disable-next-line no-await-in-loop -- deletes run in order through the one writer (cascades included)
            await writer.delete(String(id), table, { hard: true });
        }

        deleted += doomed.length;

        if (doomed.length < PAGE_ROWS) {
            return deleted;
        }
    }
};

/**
 * Swap the session's staged rows in for `tables`: overwrite or insert each, then
 * prune. Retry-safe — see the module doc for what holds on a failure. `staged`
 * says whether the session staged any `.global()` row: a session that did must
 * still hold them, one that did not empties the tables.
 */
const commitStagedGlobalRows = async (
    writer: DatabaseWriterLike,
    exec: D1Exec,
    schema: SchemaLike,
    args: { generation: string; session: string; staged: boolean; tables: ReadonlyArray<string> },
    now: number = Date.now(),
): Promise<ImportResult> => {
    await sweep(exec, now);

    const record = await readSession(exec, args.session, args.generation);

    if (record?.state === "committed" && record.result !== undefined) {
        return record.result;
    }

    if (args.staged && record === undefined) {
        throw new GlobalImportStagingError("IMPORT_SESSION_EXPIRED", `import session "${args.session}" has no staged .global() rows (expired, or aborted)`);
    }

    const { errors, inserted } = await writeStaged(writer, exec, args.session);

    // A write that failed leaves this a superset of both sides; pruning now would
    // delete rows the snapshot meant to keep but could not write.
    if (errors.length > 0) {
        return { conflicts: 0, deleted: {}, errors, inserted };
    }

    const deleted: Record<string, number> = {};

    for (const table of args.tables.filter((name) => schema.tables[name]?.shardMode?.kind === "global")) {
        // eslint-disable-next-line no-await-in-loop -- tables are pruned one at a time through the one writer
        deleted[table] = await pruneTable(writer, exec, args.session, table);
    }

    const result: ImportResult = { conflicts: 0, deleted, errors: [], inserted };

    // The marker and the drop of the staged rows go together: a retry either
    // sees the marker, or still has the rows to re-apply.
    await runAll(exec, [
        {
            params: [args.session, args.generation, now + STAGE_TTL_MS, JSON.stringify(result)],
            sql: `INSERT INTO "${SESSION_TABLE}" (session, state, generation, expires_at, result) VALUES (?, 'committed', ?, ?, ?) ON CONFLICT (session) DO UPDATE SET state = 'committed', expires_at = excluded.expires_at, result = excluded.result`,
        },
        { params: [args.session], sql: `DELETE FROM "${STAGE_TABLE}" WHERE session = ?` },
    ]);

    return result;
};

/** Forget a session of `generation`: its staged rows and its marker. Another generation's rows are left to their own expiry. */
const abortStagedGlobalRows = async (exec: D1Exec, session: string, generation: string): Promise<void> => {
    await ensureStaging(exec);
    await runAll(exec, [
        {
            params: [session, session, generation],
            sql: `DELETE FROM "${STAGE_TABLE}" WHERE session = ? AND EXISTS (SELECT 1 FROM "${SESSION_TABLE}" WHERE session = ? AND generation = ?)`,
        },
        { params: [session, generation], sql: `DELETE FROM "${SESSION_TABLE}" WHERE session = ? AND generation = ?` },
    ]);
};

export type { StageGlobalArgs };
export { abortStagedGlobalRows, commitStagedGlobalRows, GlobalImportStagingError, stageGlobalRows };
