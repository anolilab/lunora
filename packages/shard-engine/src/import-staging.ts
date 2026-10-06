/**
 * Shard-local storage for a staged replace import
 * (`POST /_lunora/admin/import?mode=replace&stage=<session>`, see
 * `@lunora/runtime`'s `import-session.ts`).
 *
 * Three reserved tables, all hidden from the data browser by their `__lunora`
 * prefix and never exported (the export reads schema tables only).
 * `__lunora_import_stage__` holds the staged rows of every open session on this
 * shard, in arrival order; on the session's root shard also the section records.
 * `__lunora_import_session__` is this shard's view of a session: `staging` while
 * rows arrive, `committed` (with the commit's result) once the swap ran, so a
 * retried commit answers the same result instead of running again.
 * `__lunora_import_manifest__`, on the root shard only, is the session as a
 * whole: scope, generation, the shards it staged on, sections, batches in
 * flight, commit steps done.
 *
 * Every session carries a generation, minted when its manifest is created. A
 * shard refuses rows or a commit of another generation, so a session id reused
 * after an expiry can never pick up rows a sweep has not cleared yet.
 *
 * Fail closed: state this module cannot read (an unknown state, a manifest that
 * does not parse) is never swept and never committed.
 */
import { LunoraError } from "@lunora/errors";

import { decodeWire, encodeWire } from "../../../shared/wire-codec";
import type { SqlExec } from "./ctx-db";
import { runSql } from "./do-exec";

const IMPORT_STAGE_TABLE = "__lunora_import_stage__";
const IMPORT_SESSION_TABLE = "__lunora_import_session__";
const IMPORT_MANIFEST_TABLE = "__lunora_import_manifest__";

/** How long a shard keeps a session's staged rows after its last batch here. Longer than the manifest's idle TTL, so a long staging run keeps them. */
const IMPORT_STAGE_TTL_MS: number = 24 * 60 * 60 * 1000;

/** How long an open session lives after its last batch (any shard). */
const IMPORT_MANIFEST_TTL_MS: number = 60 * 60 * 1000;

/** One staged row, with the source line it came from (for error attribution at commit). */
interface StagedImportRow {
    doc: Record<string, unknown>;
    line: number;
    table: string;
}

/** What one commit step wrote: per-table writes and deletions, plus anything worth reporting. */
interface ImportStepResult {
    deleted: Record<string, number>;
    inserted: Record<string, number>;
    warnings?: string[];
}

type ManifestState = "aborting" | "committed" | "committing" | "open";

/** The root shard's record of a whole staged session. */
interface ImportManifest {
    /** Staging requests begun so far — a commit is refused when one began after its prepare. */
    batches: number;
    expiresAt: number;
    /** Minted with the manifest; every shard, D1 row and storage chunk of the session carries it. */
    generation: string;
    /** Any `.global()` row was staged (in D1). */
    globals: boolean;
    /** Staging requests begun and not yet finished. A commit is refused while any is. */
    pending: number;
    received: number;
    /** Rows refused, or shards unreachable, while staging. A session with any is never committed. */
    rejected: number;
    /** Sections the snapshot's header declares (`auth`, `kv`, `storage`): those are replaced exactly at commit. */
    sections: string[];
    session: string;
    /** Shard keys that were sent staged rows. */
    shards: string[];
    state: ManifestState;
    /** Commit steps that finished, with what each wrote — a retried commit skips them. */
    steps: Record<string, ImportStepResult>;
    /** Any storage chunk was staged under the session's prefix. */
    storage: boolean;
    tables: string[];
}

const SESSION_PATTERN = /^[\w-]{1,64}$/u;
const SHARD_STATES: ReadonlySet<string> = new Set(["committed", "staging"]);
const MANIFEST_STATES: ReadonlySet<string> = new Set(["aborting", "committed", "committing", "open"]);

const conflictError = (code: string, message: string): LunoraError => new LunoraError(code, message, { status: 409 });

/** Refuse a session id that is not a short `[A-Za-z0-9_-]` token — it names storage prefixes too. */
const assertImportSessionId = (session: unknown): string => {
    if (typeof session !== "string" || !SESSION_PATTERN.test(session)) {
        throw new LunoraError("BAD_REQUEST", "an import session id is 1-64 characters of [A-Za-z0-9_-]", { status: 400 });
    }

    return session;
};

const ensureImportStaging = (sql: SqlExec): void => {
    runSql(
        sql,
        `CREATE TABLE IF NOT EXISTS "${IMPORT_STAGE_TABLE}" (seq INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, tbl TEXT NOT NULL, id TEXT, line INTEGER NOT NULL, doc TEXT NOT NULL)`,
    );
    runSql(sql, `CREATE INDEX IF NOT EXISTS "${IMPORT_STAGE_TABLE}_by_session" ON "${IMPORT_STAGE_TABLE}" (session, seq)`);
    runSql(
        sql,
        `CREATE TABLE IF NOT EXISTS "${IMPORT_SESSION_TABLE}" (session TEXT PRIMARY KEY, state TEXT NOT NULL, generation TEXT NOT NULL, expires_at INTEGER NOT NULL, result TEXT)`,
    );
    runSql(
        sql,
        `CREATE TABLE IF NOT EXISTS "${IMPORT_MANIFEST_TABLE}" (session TEXT PRIMARY KEY, state TEXT NOT NULL, expires_at INTEGER NOT NULL, manifest TEXT NOT NULL)`,
    );
};

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

const isNames = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");

/** A stored manifest, or `undefined` when it does not parse as one — such a manifest is neither swept nor committed. */
const parseManifest = (raw: string): ImportManifest | undefined => {
    let value: unknown;

    try {
        value = JSON.parse(raw);
    } catch {
        return undefined;
    }

    const candidate = value as null | { [Key in keyof ImportManifest]?: unknown };

    if (
        candidate === null ||
        typeof candidate !== "object" ||
        typeof candidate.session !== "string" ||
        typeof candidate.generation !== "string" ||
        typeof candidate.state !== "string" ||
        !MANIFEST_STATES.has(candidate.state) ||
        typeof candidate.expiresAt !== "number" ||
        !isCount(candidate.batches) ||
        !isCount(candidate.pending) ||
        !isCount(candidate.rejected) ||
        !isCount(candidate.received) ||
        typeof candidate.globals !== "boolean" ||
        typeof candidate.storage !== "boolean" ||
        !isNames(candidate.sections) ||
        !isNames(candidate.shards) ||
        !isNames(candidate.tables) ||
        typeof candidate.steps !== "object" ||
        candidate.steps === null
    ) {
        return undefined;
    }

    return candidate as unknown as ImportManifest;
};

/** This shard's record of `session`, or `undefined` when it never staged here (or was swept). */
const readShardImportSession = (
    sql: SqlExec,
    session: string,
): undefined | { generation: string; result?: Record<string, unknown>; state: "committed" | "staging" } => {
    ensureImportStaging(sql);

    const row = runSql<{ generation: string; result: null | string; state: string }>(
        sql,
        `SELECT state, generation, result FROM "${IMPORT_SESSION_TABLE}" WHERE session = ?`,
        session,
    ).toArray()[0];

    if (row === undefined) {
        return undefined;
    }

    if (!SHARD_STATES.has(row.state)) {
        throw conflictError("IMPORT_SESSION_CORRUPT", `import session "${session}" has an unreadable state on this shard`);
    }

    const state = row.state as "committed" | "staging";

    return row.result === null
        ? { generation: row.generation, state }
        : { generation: row.generation, result: JSON.parse(row.result) as Record<string, unknown>, state };
};

/** Drop this shard's staged rows and record of `session`. */
const dropShardSession = (sql: SqlExec, session: string): void => {
    runSql(sql, `DELETE FROM "${IMPORT_STAGE_TABLE}" WHERE session = ?`, session);
    runSql(sql, `DELETE FROM "${IMPORT_SESSION_TABLE}" WHERE session = ?`, session);
};

/**
 * Drop every expired session this shard can read the state of. A shard session
 * in an unknown state, a manifest that does not parse, and a manifest whose
 * commit began are kept: only a person, or a retried commit, can decide those.
 * The root's own staging of an expired open or aborting session goes with its
 * manifest — the root knows it is dead.
 * @returns the expired manifests removed (root shard only), so the caller can clean their other shards, D1 rows and storage chunks
 */
const sweepImportStaging = (sql: SqlExec, now: number): ImportManifest[] => {
    ensureImportStaging(sql);

    runSql(
        sql,
        `DELETE FROM "${IMPORT_STAGE_TABLE}" WHERE session IN (SELECT session FROM "${IMPORT_SESSION_TABLE}" WHERE expires_at < ? AND state IN ('staging', 'committed'))`,
        now,
    );
    runSql(sql, `DELETE FROM "${IMPORT_SESSION_TABLE}" WHERE expires_at < ? AND state IN ('staging', 'committed')`, now);

    const expired: ImportManifest[] = [];

    for (const row of runSql<{ manifest: string; session: string }>(
        sql,
        `SELECT session, manifest FROM "${IMPORT_MANIFEST_TABLE}" WHERE expires_at < ?`,
        now,
    )) {
        const manifest = parseManifest(row.manifest);

        if (manifest === undefined || manifest.state === "committing") {
            continue;
        }

        if (manifest.state !== "committed" && readShardImportSession(sql, row.session)?.generation === manifest.generation) {
            dropShardSession(sql, row.session);
        }

        runSql(sql, `DELETE FROM "${IMPORT_MANIFEST_TABLE}" WHERE session = ?`, row.session);
        expired.push(manifest);
    }

    return expired;
};

/** Refuse a session of another generation on this shard (an id reused before the old rows were swept). */
const assertGeneration = (record: undefined | { generation: string }, session: string, generation: string): void => {
    if (record !== undefined && record.generation !== generation) {
        throw conflictError("IMPORT_SESSION_STALE", `import session "${session}" on this shard belongs to an earlier session of the same id`);
    }
};

/** Append rows to `session`'s staging on this shard, refreshing its expiry. Refused once the session committed here, or for another generation. */
const stageImportRows = (sql: SqlExec, session: string, generation: string, rows: ReadonlyArray<StagedImportRow>, now: number): Record<string, number> => {
    const record = readShardImportSession(sql, session);

    assertGeneration(record, session, generation);

    if (record?.state === "committed") {
        throw conflictError("IMPORT_SESSION_COMMITTED", `import session "${session}" is already committed`);
    }

    runSql(
        sql,
        `INSERT INTO "${IMPORT_SESSION_TABLE}" (session, state, generation, expires_at) VALUES (?, 'staging', ?, ?) ON CONFLICT (session) DO UPDATE SET expires_at = excluded.expires_at`,
        session,
        generation,
        now + IMPORT_STAGE_TTL_MS,
    );

    const staged: Record<string, number> = {};

    for (const row of rows) {
        const id = row.doc["_id"];

        runSql(
            sql,
            `INSERT INTO "${IMPORT_STAGE_TABLE}" (session, tbl, id, line, doc) VALUES (?, ?, ?, ?, ?)`,
            session,
            row.table,
            // eslint-disable-next-line unicorn/no-null -- SQL NULL for a row without an `_id` (sections)
            typeof id === "string" ? id : null,
            row.line,
            JSON.stringify(encodeWire(row.doc)),
        );
        staged[row.table] = (staged[row.table] ?? 0) + 1;
    }

    return staged;
};

/** Keep `session` alive on this shard (a commit's dry run touches every shard before the real one). */
const touchShardImportSession = (sql: SqlExec, session: string, now: number): void => {
    runSql(sql, `UPDATE "${IMPORT_SESSION_TABLE}" SET expires_at = ? WHERE session = ?`, now + IMPORT_STAGE_TTL_MS, session);
};

/**
 * One page of `session`'s staged rows after `afterSeq`, in arrival order:
 * schema-table rows (no `sections`) or the `$`-prefixed section records named
 * in `sections`.
 */
const stagedImportPage = (
    sql: SqlExec,
    session: string,
    options: { afterSeq: number; limit: number; sections?: ReadonlyArray<string> },
): { rows: StagedImportRow[]; seq: number } => {
    ensureImportStaging(sql);

    let filter = `substr(tbl, 1, 1) <> '$'`;

    if (options.sections !== undefined) {
        filter = options.sections.length === 0 ? "0" : `tbl IN (${options.sections.map(() => "?").join(", ")})`;
    }

    const rows = runSql<{ doc: string; line: number; seq: number; tbl: string }>(
        sql,
        `SELECT seq, tbl, line, doc FROM "${IMPORT_STAGE_TABLE}" WHERE session = ? AND seq > ? AND ${filter} ORDER BY seq LIMIT ?`,
        session,
        options.afterSeq,
        ...(options.sections ?? []),
        options.limit,
    ).toArray();

    return {
        rows: rows.map((row) => {
            return { doc: decodeWire(JSON.parse(row.doc)) as Record<string, unknown>, line: row.line, table: row.tbl };
        }),
        seq: rows.at(-1)?.seq ?? options.afterSeq,
    };
};

/**
 * Every `_id` staged for `session`'s schema tables on this shard — what the
 * commit's prune keeps.
 *
 * ponytail: the ids are held in memory for the prune (tens of bytes each, so a
 * few million rows per shard); an anti-join against the stage table lifts it.
 */
const stagedImportIds = (sql: SqlExec, session: string): Set<string> =>
    new Set(
        runSql<{ id: string }>(sql, `SELECT id FROM "${IMPORT_STAGE_TABLE}" WHERE session = ? AND id IS NOT NULL AND substr(tbl, 1, 1) <> '$'`, session)
            .toArray()
            .map(({ id }) => id),
    );

/** Record the swap: drop the staged rows and keep the result, so a retried commit answers it again. */
const markShardImportCommitted = (sql: SqlExec, session: string, generation: string, result: Record<string, unknown>, now: number): void => {
    runSql(sql, `DELETE FROM "${IMPORT_STAGE_TABLE}" WHERE session = ? AND substr(tbl, 1, 1) <> '$'`, session);
    runSql(
        sql,
        `INSERT INTO "${IMPORT_SESSION_TABLE}" (session, state, generation, expires_at, result) VALUES (?, 'committed', ?, ?, ?) ON CONFLICT (session) DO UPDATE SET state = 'committed', expires_at = excluded.expires_at, result = excluded.result`,
        session,
        generation,
        now + IMPORT_STAGE_TTL_MS,
        JSON.stringify(result),
    );
};

/** Forget `session` on this shard when it is of `generation` (or was never here). Another generation's rows are left to their own expiry. */
const dropImportSession = (sql: SqlExec, session: string, generation: string): boolean => {
    const record = readShardImportSession(sql, session);

    if (record !== undefined && record.generation !== generation) {
        return false;
    }

    dropShardSession(sql, session);

    return true;
};

/**
 * The manifest of `session` on this (root) shard, or `undefined` when there is
 * none or it expired while open. Throws IMPORT_SESSION_CORRUPT for one that
 * does not parse: unknown state refuses, it never reads as absent.
 */
const readImportManifest = (sql: SqlExec, session: string, now: number): ImportManifest | undefined => {
    ensureImportStaging(sql);

    const row = runSql<{ manifest: string }>(sql, `SELECT manifest FROM "${IMPORT_MANIFEST_TABLE}" WHERE session = ?`, session).toArray()[0];

    if (row === undefined) {
        return undefined;
    }

    const manifest = parseManifest(row.manifest);

    if (manifest === undefined) {
        throw conflictError("IMPORT_SESSION_CORRUPT", `import session "${session}" has a manifest that cannot be read`);
    }

    return manifest.state === "open" && manifest.expiresAt < now ? undefined : manifest;
};

const writeImportManifest = (sql: SqlExec, manifest: ImportManifest): void => {
    runSql(
        sql,
        `INSERT INTO "${IMPORT_MANIFEST_TABLE}" (session, state, expires_at, manifest) VALUES (?, ?, ?, ?) ON CONFLICT (session) DO UPDATE SET state = excluded.state, expires_at = excluded.expires_at, manifest = excluded.manifest`,
        manifest.session,
        manifest.state,
        manifest.expiresAt,
        JSON.stringify(manifest),
    );
};

/** What one staging request adds to the manifest: `begin` opens a batch (and the session on its first), its end closes it with what it refused. */
interface ManifestTouch {
    begin: boolean;
    globals?: boolean;
    received?: number;
    rejected?: number;
    sections?: ReadonlyArray<string>;
    shards?: ReadonlyArray<string>;
    storage?: boolean;
    tables: ReadonlyArray<string>;
}

const sameTables = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean => {
    const byName = (left: string, right: string): number => left.localeCompare(right);

    return [...a].toSorted(byName).join(",") === [...b].toSorted(byName).join(",");
};

const freshManifest = (session: string, tables: ReadonlyArray<string>): ImportManifest => {
    return {
        batches: 0,
        expiresAt: 0,
        generation: crypto.randomUUID(),
        globals: false,
        pending: 0,
        received: 0,
        rejected: 0,
        sections: [],
        session,
        shards: [],
        state: "open",
        steps: {},
        storage: false,
        tables: [...tables],
    };
};

/**
 * Begin or end one staging request of `session`, refreshing its expiry. The
 * first `begin` opens the session. A session keeps the replace scope it was
 * opened with, and takes no more batches once its commit or abort began; an
 * `end` with no open batch is refused, so a stray request cannot mark a
 * session complete.
 */
const touchImportManifest = (sql: SqlExec, session: string, touch: ManifestTouch, now: number): { created: boolean; manifest: ImportManifest } => {
    const existing = readImportManifest(sql, session, now);

    if (existing === undefined && !touch.begin) {
        throw new LunoraError("IMPORT_SESSION_NOT_FOUND", `import session "${session}" does not exist or has expired`, { status: 404 });
    }

    if (existing !== undefined && existing.state !== "open") {
        throw conflictError(
            existing.state === "committed" ? "IMPORT_SESSION_COMMITTED" : "IMPORT_SESSION_CLOSED",
            `import session "${session}" is ${existing.state === "committed" ? "already committed" : existing.state}`,
        );
    }

    if (existing !== undefined && !sameTables(existing.tables, touch.tables)) {
        throw new LunoraError("IMPORT_SESSION_MISMATCH", `import session "${session}" was opened over other tables`, { status: 400 });
    }

    if (existing !== undefined && !touch.begin && existing.pending === 0) {
        throw conflictError("IMPORT_SESSION_CORRUPT", `import session "${session}" has no staging request in flight to finish`);
    }

    const base = existing ?? freshManifest(session, touch.tables);
    const manifest: ImportManifest = {
        ...base,
        batches: base.batches + (touch.begin ? 1 : 0),
        expiresAt: now + IMPORT_MANIFEST_TTL_MS,
        globals: base.globals || touch.globals === true,
        pending: base.pending + (touch.begin ? 1 : -1),
        received: base.received + (touch.received ?? 0),
        rejected: base.rejected + (touch.rejected ?? 0),
        sections: [...new Set([...base.sections, ...(touch.sections ?? [])])],
        shards: [...new Set([...base.shards, ...(touch.shards ?? [])])],
        storage: base.storage || touch.storage === true,
    };

    writeImportManifest(sql, manifest);

    return { created: existing === undefined, manifest };
};

/** A manifest transition, each a compare-and-set against the state it expects. */
type ManifestChange =
    { batches: number; state: "committing" } | { state: "aborting" } | { state: "committed" } | { step: string; stepResult: ImportStepResult };

/** Why `manifest` cannot take `change`, or `undefined` when it can. */
const transitionRefusal = (manifest: ImportManifest, change: ManifestChange): LunoraError | undefined => {
    if ("step" in change || change.state === "committed") {
        return manifest.state === "committing"
            ? undefined
            : conflictError("IMPORT_SESSION_NOT_COMMITTING", `import session "${manifest.session}" is ${manifest.state}`);
    }

    if (change.state === "aborting") {
        return manifest.state === "open" || manifest.state === "aborting"
            ? undefined
            : conflictError("IMPORT_SESSION_COMMITTING", `import session "${manifest.session}" is ${manifest.state} — send the commit again to finish it`);
    }

    if (manifest.state !== "open") {
        return conflictError("IMPORT_SESSION_CLOSED", `import session "${manifest.session}" is ${manifest.state}`);
    }

    if (manifest.rejected > 0) {
        return conflictError("IMPORT_SESSION_REJECTED", `import session "${manifest.session}" had refused rows or unreachable shards while staging — abort it`);
    }

    if (manifest.pending > 0) {
        return conflictError(
            "IMPORT_SESSION_INCOMPLETE",
            `import session "${manifest.session}" has ${String(manifest.pending)} staging request(s) that never finished — abort it`,
        );
    }

    return manifest.batches === change.batches
        ? undefined
        : conflictError("IMPORT_SESSION_CHANGED", `import session "${manifest.session}" took another batch after the commit's prepare — commit again`);
};

/**
 * Move `session`'s manifest on: `committing` before the first write (only from
 * a clean `open` with no batch since the prepare), a finished `step`,
 * `committed`, or `aborting`. Every transition is a compare-and-set on the
 * state it expects, so a commit and an abort cannot both proceed.
 */
const advanceImportManifest = (sql: SqlExec, session: string, change: ManifestChange, now: number): ImportManifest => {
    const manifest = readImportManifest(sql, session, now);

    if (manifest === undefined) {
        throw new LunoraError("IMPORT_SESSION_NOT_FOUND", `import session "${session}" does not exist or has expired`, { status: 404 });
    }

    const refusal = transitionRefusal(manifest, change);

    if (refusal !== undefined) {
        throw refusal;
    }

    const next: ImportManifest =
        "step" in change
            ? { ...manifest, expiresAt: now + IMPORT_MANIFEST_TTL_MS, steps: { ...manifest.steps, [change.step]: change.stepResult } }
            : { ...manifest, expiresAt: now + IMPORT_MANIFEST_TTL_MS, state: change.state };

    writeImportManifest(sql, next);
    // The section records ride this shard's own session record, so it lives as long as the manifest.
    touchShardImportSession(sql, session, now);

    if ("state" in change && change.state === "committed") {
        // The section records were the commit's input; the manifest alone answers a retry now.
        runSql(sql, `DELETE FROM "${IMPORT_STAGE_TABLE}" WHERE session = ? AND substr(tbl, 1, 1) = '$'`, session);
    }

    return next;
};

/** Drop an aborting session's manifest and this root's own staging of it — the abort's last step. */
const dropImportManifest = (sql: SqlExec, session: string, now: number): void => {
    const manifest = readImportManifest(sql, session, now);

    if (manifest === undefined) {
        return;
    }

    if (manifest.state !== "aborting") {
        throw conflictError("IMPORT_SESSION_CLOSED", `import session "${session}" is ${manifest.state}, not aborting`);
    }

    dropImportSession(sql, session, manifest.generation);
    runSql(sql, `DELETE FROM "${IMPORT_MANIFEST_TABLE}" WHERE session = ?`, session);
};

export type { ImportManifest, ImportStepResult, ManifestChange, ManifestTouch, StagedImportRow };
export {
    advanceImportManifest,
    assertImportSessionId,
    dropImportManifest,
    dropImportSession,
    IMPORT_MANIFEST_TTL_MS,
    IMPORT_STAGE_TTL_MS,
    markShardImportCommitted,
    readImportManifest,
    readShardImportSession,
    stagedImportIds,
    stagedImportPage,
    stageImportRows,
    sweepImportStaging,
    touchImportManifest,
    touchShardImportSession,
};
