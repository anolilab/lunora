/**
 * The shard half of a staged replace import (the runtime's `import-session.ts`
 * drives it): the `__lunora_admin__:import*` admin RPCs.
 *
 * `importStage` appends rows to the session's staging on this shard.
 * `importCommit` swaps the staged rows in for the session's tables in ONE
 * storage transaction — overwrite by `_id`, then prune every row the snapshot
 * does not hold — and any per-row error rolls the whole swap back. `dryRun`
 * runs the same swap and always rolls it back: the runtime's prepare phase, so
 * a row that cannot land fails the commit before any shard is written. A
 * committed shard keeps its result, so a retried commit answers it again.
 * `importAbort` forgets the session here. `importManifest` and
 * `importStagedRows` serve the session record and the section records, which
 * the root shard keeps.
 */
import { LunoraError } from "@lunora/errors";
import type { ImportError, ImportShardResult, ImportStepResult, ManifestChange, SqlExec, StagedImportRow } from "@lunora/shard-engine";
import {
    ADMIN_FUNCTIONS,
    advanceImportManifest,
    assertImportSessionId,
    dropImportManifest,
    dropImportSession,
    markShardImportCommitted,
    readImportManifest,
    readShardImportSession,
    replaceRefusal,
    stagedImportIds,
    stagedImportPage,
    stageImportRows,
    sweepImportStaging,
    touchImportManifest,
    touchShardImportSession,
} from "@lunora/shard-engine";

import type { RunShardImportArgs } from "./admin-rpc-args";

/** What the import-session RPCs need of the shard they run on. */
interface ImportSessionShard {
    recordAudit: (op: string, fields: { detail?: Record<string, unknown> }) => void;
    runInTransaction: <T>(handler: () => Promise<T>) => Promise<T>;
    runShardImport: (args: RunShardImportArgs) => Promise<ImportShardResult>;
    sql: SqlExec;
}

/** Staged rows per write page at commit — bounds what one `runShardImport` call holds. */
const COMMIT_PAGE_ROWS = 200;

const stringList = (raw: unknown): string[] => (Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : []);

/** The staged rows of one `importStage` call; a malformed entry keeps its line so it is reported, not dropped. */
const parseStagedRows = (raw: unknown): StagedImportRow[] =>
    (Array.isArray(raw) ? raw : []).map((entry, index) => {
        const candidate = (entry ?? {}) as { doc?: unknown; line?: unknown; table?: unknown };

        return {
            doc: candidate.doc !== null && typeof candidate.doc === "object" && !Array.isArray(candidate.doc) ? (candidate.doc as Record<string, unknown>) : {},
            line: typeof candidate.line === "number" ? candidate.line : index + 1,
            table: typeof candidate.table === "string" ? candidate.table : "",
        };
    });

const isSectionRow = (row: StagedImportRow): boolean => row.table.startsWith("$");

/** The `importStage` audit and the `importCommit` one mirror `importShard`'s: the mode, the tables it owns, and the counts. */
const sessionAuditDetail = (session: string, tables: ReadonlyArray<string>, counts: Record<string, unknown>): Record<string, unknown> => {
    return { ...counts, mode: "replace", replaceTables: tables, session };
};

/** The session's generation, which every session RPC but the manifest's carries. */
const generationOf = (args: Record<string, unknown>): string => {
    const { generation } = args;

    if (typeof generation !== "string" || generation.length === 0) {
        throw new LunoraError("BAD_REQUEST", "an import session RPC needs the session's `generation`", { status: 400 });
    }

    return generation;
};

const stage = (shard: ImportSessionShard, args: Record<string, unknown>, now: number): { errors: ImportError[]; staged: Record<string, number> } => {
    const session = assertImportSessionId(args["session"]);
    const generation = generationOf(args);
    const tables = stringList(args["tables"]);
    const scope = new Set(tables);
    const rows = parseStagedRows(args["rows"]);
    const errors: ImportError[] = [];

    sweepImportStaging(shard.sql, now);

    for (const row of rows) {
        const refusal = isSectionRow(row) ? undefined : replaceRefusal(scope, row);

        if (refusal !== undefined) {
            errors.push({ code: "BAD_ROW", line: row.line, message: refusal, table: row.table });
        }
    }

    // A session with a refused row is never committed, so nothing of the batch is kept.
    const staged = errors.length > 0 ? {} : stageImportRows(shard.sql, session, generation, rows, now);

    shard.recordAudit("importStage", { detail: sessionAuditDetail(session, tables, { errors: errors.length, staged }) });

    return { errors, staged };
};

/** Write every staged page through the writer, then prune — the body of the commit's one transaction. */
const swapStaged = async (shard: ImportSessionShard, session: string, tables: ReadonlyArray<string>): Promise<ImportShardResult> => {
    const inserted: Record<string, number> = {};
    let afterSeq = 0;

    for (;;) {
        const page = stagedImportPage(shard.sql, session, { afterSeq, limit: COMMIT_PAGE_ROWS });

        if (page.rows.length === 0) {
            break;
        }

        // eslint-disable-next-line no-await-in-loop -- pages go through the one writer in staging order
        const result = await shard.runShardImport({
            replaceTables: tables,
            rows: page.rows.map(({ doc, table }) => {
                return { doc, table };
            }),
            startLine: 1,
        });

        if (result.errors.length > 0) {
            // `runShardImport` numbers a page's rows from 1; report the source line each was staged with.
            return {
                conflicts: 0,
                errors: result.errors.map((error) => {
                    return { ...error, line: page.rows[error.line - 1]?.line ?? error.line };
                }),
                inserted: {},
            };
        }

        for (const [table, count] of Object.entries(result.inserted)) {
            inserted[table] = (inserted[table] ?? 0) + count;
        }

        afterSeq = page.seq;
    }

    const pruned = await shard.runShardImport({ keepIds: stagedImportIds(shard.sql, session), replaceTables: tables, rows: [] });

    return { conflicts: 0, deleted: pruned.deleted ?? {}, errors: pruned.errors, inserted };
};

/** Thrown inside the commit transaction to roll it back while keeping the outcome. */
const ROLLBACK = new LunoraError("IMPORT_REFUSED", "staged import rolled back", { status: 400 });

const commit = async (shard: ImportSessionShard, args: Record<string, unknown>, now: number): Promise<ImportShardResult & { committed?: boolean }> => {
    const session = assertImportSessionId(args["session"]);
    const tables = stringList(args["tables"]);
    const dryRun = args["dryRun"] === true;
    const generation = generationOf(args);

    sweepImportStaging(shard.sql, now);

    const record = readShardImportSession(shard.sql, session);

    // Rows of an earlier session under the same id are not this commit's to swap in.
    if (record !== undefined && record.generation !== generation) {
        throw new LunoraError("IMPORT_SESSION_STALE", `import session "${session}" on this shard belongs to an earlier session of the same id`, {
            status: 409,
        });
    }

    if (record?.state === "committed") {
        return { ...(record.result as unknown as ImportShardResult), committed: true };
    }

    // A shard the session staged rows on must still hold them: committing it
    // without them would prune every row of its tables.
    if (args["staged"] === true && record === undefined) {
        throw new LunoraError("IMPORT_SESSION_EXPIRED", `import session "${session}" has no staged rows on this shard (expired, or aborted)`, { status: 410 });
    }

    if (record !== undefined) {
        touchShardImportSession(shard.sql, session, now);
    }

    let outcome: ImportShardResult | undefined;

    try {
        const result = await shard.runInTransaction(async () => {
            const swapped = await swapStaged(shard, session, tables);

            if (dryRun || swapped.errors.length > 0) {
                outcome = swapped;

                throw ROLLBACK;
            }

            markShardImportCommitted(shard.sql, session, generation, swapped as unknown as Record<string, unknown>, now);

            return swapped;
        });

        shard.recordAudit("importCommit", {
            detail: sessionAuditDetail(session, tables, {
                conflicts: result.conflicts,
                deleted: result.deleted,
                errors: result.errors.length,
                inserted: result.inserted,
            }),
        });

        return { ...result, committed: true };
    } catch (error: unknown) {
        if (outcome === undefined) {
            throw error;
        }

        return { conflicts: 0, deleted: {}, errors: outcome.errors, inserted: {} };
    }
};

/** A manifest transition off the wire; anything else is refused rather than guessed. */
const parseChange = (args: Record<string, unknown>): ManifestChange => {
    if (typeof args["step"] === "string") {
        return { step: args["step"], stepResult: args["stepResult"] as ImportStepResult };
    }

    switch (args["state"]) {
        case "aborting": {
            return { state: "aborting" };
        }
        case "committed": {
            return { state: "committed" };
        }
        case "committing": {
            if (typeof args["batches"] !== "number") {
                throw new LunoraError("BAD_REQUEST", "a commit's `committing` transition needs the `batches` its prepare saw", { status: 400 });
            }

            return { batches: args["batches"], state: "committing" };
        }
        default: {
            throw new LunoraError("BAD_REQUEST", "importManifest `advance` needs a `step` or a known `state`", { status: 400 });
        }
    }
};

const manifest = (shard: ImportSessionShard, args: Record<string, unknown>, now: number): Record<string, unknown> => {
    const session = assertImportSessionId(args["session"]);

    switch (args["op"]) {
        case "advance": {
            return { manifest: advanceImportManifest(shard.sql, session, parseChange(args), now) };
        }
        case "drop": {
            dropImportManifest(shard.sql, session, now);

            return { dropped: true };
        }
        case "get": {
            // eslint-disable-next-line unicorn/no-null -- JSON has no `undefined`
            return { manifest: readImportManifest(shard.sql, session, now) ?? null };
        }
        case "touch": {
            const expired = sweepImportStaging(shard.sql, now);
            const touched = touchImportManifest(
                shard.sql,
                session,
                {
                    begin: args["begin"] === true,
                    globals: args["globals"] === true,
                    received: typeof args["received"] === "number" ? args["received"] : 0,
                    rejected: typeof args["rejected"] === "number" ? args["rejected"] : 0,
                    sections: stringList(args["sections"]),
                    shards: stringList(args["shards"]),
                    storage: args["storage"] === true,
                    tables: stringList(args["tables"]),
                },
                now,
            );

            return { ...touched, expired };
        }
        default: {
            throw new LunoraError("BAD_REQUEST", "importManifest `op` must be `touch`, `get`, `advance` or `drop`", { status: 400 });
        }
    }
};

/**
 * Serve one `__lunora_admin__:import*` session RPC, or `undefined` when
 * `functionPath` is not one of them. Every write here lands in the shard's own
 * SQLite, so the caller flushes changed tables after a commit.
 */
const handleImportSessionRpc = async (shard: ImportSessionShard, functionPath: string, args: Record<string, unknown>): Promise<unknown> => {
    const now = Date.now();

    switch (functionPath) {
        case ADMIN_FUNCTIONS.importAbort: {
            const session = assertImportSessionId(args["session"]);
            // Only this session's own rows: another generation's are left to their expiry.
            const aborted = dropImportSession(shard.sql, session, generationOf(args));

            shard.recordAudit("importAbort", { detail: { aborted, mode: "replace", session } });

            return { aborted };
        }
        case ADMIN_FUNCTIONS.importCommit: {
            return commit(shard, args, now);
        }
        case ADMIN_FUNCTIONS.importManifest: {
            return manifest(shard, args, now);
        }
        case ADMIN_FUNCTIONS.importStage: {
            return stage(shard, args, now);
        }
        case ADMIN_FUNCTIONS.importStagedRows: {
            const session = assertImportSessionId(args["session"]);

            return stagedImportPage(shard.sql, session, {
                afterSeq: typeof args["afterSeq"] === "number" ? args["afterSeq"] : 0,
                limit: Math.min(Math.max(typeof args["limit"] === "number" ? args["limit"] : 100, 1), 1000),
                sections: stringList(args["sections"]),
            });
        }
        default: {
            return undefined;
        }
    }
};

export type { ImportSessionShard };
export { handleImportSessionRpc };
