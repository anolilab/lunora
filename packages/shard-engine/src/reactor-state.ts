/**
 * The `__reactor_state` table: what each `onQueryChange` reactor saw last time.
 *
 * A reactor is a server-side subscriber — "run this when the RESULT of this read
 * changes" — and answering "changed since what?" needs a baseline. Two things
 * are stored per reactor, and both have to be durable:
 *
 * - **`digest`** — a content digest (`shared/content-digest.ts`) of the reactor's `select` result at
 * the moment it last ran. The reactor fires only when a fresh `select` digests
 * differently, which is exactly what separates it from a `.triggers()` handler:
 * a trigger fires on a row write, a reactor fires on a result changing.
 * - **`tables`** — the read footprint of that run, so a later flush that touched
 * none of them can skip re-running `select` at all. Learned from the run rather
 * than declared, the same way a live subscription's footprint is.
 *
 * **Why durable and not a heap `Map`.** This is the third time this package has
 * had to answer that question, and the first two answers were bugs: a
 * hibernation eviction silently cleared an in-memory `WeakMap` in
 * `ctx-db-global-shape-snapshot.ts` (phantom rows that never went away) and
 * again in `ctx-db-shape-poke-cursor.ts` (an unbounded re-scan on every wake).
 * A reactor baseline lost to eviction is the same family of bug: the next flush
 * would digest against nothing, decide "changed", and re-fire every reactor on
 * the shard — turning an idle wake into a write storm.
 *
 * The degradation direction is deliberate and matches those two: a MISSING row
 * means "assume changed", which costs one extra run. There is no state that
 * causes a reactor to be skipped when it should have fired.
 */

import { sql as dsql } from "drizzle-orm";

import type { SqlExec } from "./ctx-db";
import { runDrizzle } from "./do-exec";

/** Reserved table holding each reactor's last-seen digest and read footprint. */
const REACTOR_STATE_TABLE = "__reactor_state";

/** What a reactor observed on its last run, plus the counters an operator reads. */
interface ReactorState {
    /** Digest of the `select` result the reactor last ran against. */
    digest: string;

    /** Redacted message of the most recent contained failure, if any. */
    lastError?: string;

    /** Wall-clock millis of the last dispatch, run or suppressed. `0` when never dispatched. */
    lastRanAt: number;

    /**
     * Counters since the shard's first dispatch of this reactor. Durable, unlike
     * the DO's in-memory metrics, which reset on hibernation — a reactor fires on
     * background flushes and an operator asking "is this thing running?" needs an
     * answer that survives the shard going idle, which is most of the time.
     */
    stats: ReactorStats;

    /**
     * Tables that run read. A later flush touching none of them cannot have
     * changed the result, so `select` is not re-run.
     *
     * `undefined` means "not known" — never "none". A reactor that has never run,
     * or whose row predates this column, must be treated as touching everything.
     */
    tables?: ReadonlyArray<string>;
}

/** Durable per-reactor counters, surfaced by the studio's Reactors panel. */
interface ReactorStats {
    /** Dispatches that ended in a contained throw. */
    errors: number;

    /** Dispatches where the digest changed and the app handler ran. */
    runs: number;

    /**
     * Dispatches where `select` re-ran but the digest matched, so the handler did
     * NOT run. A high ratio against `runs` is the signal that a reactor is
     * watching too much: the read is being re-evaluated by writes that cannot
     * change its result, and its `select` wants narrowing or an index.
     */
    suppressed: number;
}

/**
 * Observability columns and their DDL, in the order they must be added. Kept as
 * data so {@link migrateReactorState} adds exactly what a pragma check says is
 * missing, rather than repeating the same guard five times.
 */
const OBSERVABILITY_COLUMNS: ReadonlyArray<readonly [string, string]> = [
    ["runs", "runs INTEGER NOT NULL DEFAULT 0"],
    ["suppressed", "suppressed INTEGER NOT NULL DEFAULT 0"],
    ["errors", "errors INTEGER NOT NULL DEFAULT 0"],
    ["last_ran_at", "last_ran_at INTEGER NOT NULL DEFAULT 0"],
    ["last_error", "last_error TEXT"],
];

/**
 * Create the reactor-state table. Keyed by the reactor's registered function
 * path, which is stable across deploys — so a reactor keeps its baseline when
 * unrelated code changes, and correctly loses it (re-firing once) when it is
 * renamed.
 */
const migrateReactorState = (sql: SqlExec): void => {
    runDrizzle(
        sql,
        dsql`CREATE TABLE IF NOT EXISTS ${dsql.identifier(REACTOR_STATE_TABLE)} (
            path TEXT PRIMARY KEY,
            digest TEXT NOT NULL,
            tables TEXT NOT NULL,
            runs INTEGER NOT NULL DEFAULT 0,
            suppressed INTEGER NOT NULL DEFAULT 0,
            errors INTEGER NOT NULL DEFAULT 0,
            last_ran_at INTEGER NOT NULL DEFAULT 0,
            last_error TEXT
        )`,
    );

    // The counter columns landed after the baseline ones, so a DO persisted
    // between the two gets them added here (defaulted). Pragma-checked rather
    // than blindly ALTERed so a fresh table — created above WITH the columns —
    // doesn't raise "duplicate column"; same shape as the aggregate companion's
    // `__count__` backfill in `ctx-db-migrations.ts`.
    const existing = new Set(
        runDrizzle<{ name: string }>(sql, dsql`PRAGMA table_info(${dsql.identifier(REACTOR_STATE_TABLE)})`)
            .toArray()
            .map((column) => column.name),
    );

    for (const [column, definition] of OBSERVABILITY_COLUMNS) {
        if (!existing.has(column)) {
            runDrizzle(sql, dsql`ALTER TABLE ${dsql.identifier(REACTOR_STATE_TABLE)} ADD COLUMN ${dsql.raw(definition)}`);
        }
    }
};

/**
 * Decode the stored footprint. Anything unparseable degrades to `undefined`
 * ("unknown", so re-run) rather than to an empty array ("touches nothing", which
 * would silently stop the reactor forever).
 */
const parseTables = (raw: unknown): ReadonlyArray<string> | undefined => {
    if (typeof raw !== "string") {
        return undefined;
    }

    try {
        const parsed: unknown = JSON.parse(raw);

        return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Read a reactor's baseline.
 * @returns the stored state, or `undefined` when the reactor has never run —
 * which callers must read as "assume the result changed and the footprint is
 * unknown", never as "nothing changed".
 */
/** One stored row, before it is shaped into a {@link ReactorState}. */
interface ReactorRow {
    digest: string;
    errors: number;
    last_error: null | string;
    last_ran_at: number;
    path: string;
    runs: number;
    suppressed: number;
    tables: string;
}

/** Coerce a stored counter to a number; anything unreadable degrades to `0`. */
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Shape a stored row into a {@link ReactorState}. */
const toState = (row: ReactorRow): ReactorState => {
    return {
        digest: row.digest,
        ...(typeof row.last_error === "string" && row.last_error.length > 0 ? { lastError: row.last_error } : {}),
        lastRanAt: count(row.last_ran_at),
        stats: { errors: count(row.errors), runs: count(row.runs), suppressed: count(row.suppressed) },
        tables: parseTables(row.tables),
    };
};

const REACTOR_COLUMNS = "path, digest, tables, runs, suppressed, errors, last_ran_at, last_error";

const readReactorState = (sql: SqlExec, path: string): ReactorState | undefined => {
    const [row] = runDrizzle<ReactorRow>(sql, dsql`SELECT ${dsql.raw(REACTOR_COLUMNS)} FROM ${dsql.identifier(REACTOR_STATE_TABLE)} WHERE path = ${path}`);

    if (row === undefined || typeof row.digest !== "string") {
        return undefined;
    }

    return toState(row);
};

/**
 * Every reactor this shard has ever dispatched, with its baseline and counters —
 * the studio's Reactors panel and the `listReactors` admin read.
 *
 * Ordered by path so the panel is stable between polls rather than reshuffling
 * on every render. A reactor declared but never dispatched has no row and is
 * absent here; the panel joins against the manifest so it can still show it as
 * "never run", which is a materially different state from "running and quiet".
 * @returns each reactor's path paired with its state.
 */
const listReactorStates = (sql: SqlExec): { path: string; state: ReactorState }[] =>
    runDrizzle<ReactorRow>(sql, dsql`SELECT ${dsql.raw(REACTOR_COLUMNS)} FROM ${dsql.identifier(REACTOR_STATE_TABLE)} ORDER BY path`)
        .toArray()
        .map((row) => {
            return { path: row.path, state: toState(row) };
        });

/** Which counter a dispatch advances — mirrors `ReactorOutcome.ran` plus the failure case. */
type ReactorDispatchResult = "error" | "ran" | "suppressed";

/**
 * Record what a reactor dispatch observed: the new baseline, and the counter its
 * outcome advances.
 *
 * The counters are incremented in SQL (`runs = runs + 1`) rather than read-then-
 * written, so two dispatches cannot race a stale read — a DO serializes events,
 * but the arithmetic belongs next to the write either way.
 *
 * A failure passes `digest`/`tables` as `undefined`: the baseline must NOT move
 * for a reactor that threw (it never observed this result, so the next flush has
 * to offer it again), while the error counter and message must. That split is
 * why this takes an outcome rather than a plain row.
 */
const writeReactorState = (
    sql: SqlExec,
    path: string,
    outcome: { digest?: string; error?: string; now: number; result: ReactorDispatchResult; tables?: ReadonlyArray<string> },
): void => {
    const { digest, error, now, result, tables } = outcome;
    // A failed dispatch keeps whatever baseline was already there; on the very
    // first dispatch there is none, so the row seeds with an empty digest and an
    // unknown footprint — which `reactorNeedsRun` reads as "must run".
    const digestValue = digest ?? "";
    const tablesValue = tables === undefined ? "" : JSON.stringify([...tables]);
    // eslint-disable-next-line unicorn/no-null -- a SQL bind: the column is nullable and SQLite needs a real NULL, not `undefined`
    const errorValue = error ?? null;
    // `last_error` describes the LAST dispatch, not the lifetime — that is what
    // makes `handleListReactors` able to call a reactor that failed once and has
    // run cleanly since "active" rather than "failing". So a non-error outcome
    // CLEARS the column; only an `"error"` result writes into it. Preserving it
    // across a successful run would pin the reactor to "failing" forever, since
    // nothing else ever nulls it.

    runDrizzle(
        sql,
        dsql`INSERT INTO ${dsql.identifier(REACTOR_STATE_TABLE)} (path, digest, tables, runs, suppressed, errors, last_ran_at, last_error)
             VALUES (
                ${path},
                ${digestValue},
                ${tablesValue},
                ${result === "ran" ? 1 : 0},
                ${result === "suppressed" ? 1 : 0},
                ${result === "error" ? 1 : 0},
                ${now},
                ${errorValue}
             )
             ON CONFLICT(path) DO UPDATE SET
                digest = ${digest === undefined ? dsql.raw(`${REACTOR_STATE_TABLE}.digest`) : dsql`excluded.digest`},
                tables = ${tables === undefined ? dsql.raw(`${REACTOR_STATE_TABLE}.tables`) : dsql`excluded.tables`},
                runs = ${dsql.raw(`${REACTOR_STATE_TABLE}.runs`)} + ${result === "ran" ? 1 : 0},
                suppressed = ${dsql.raw(`${REACTOR_STATE_TABLE}.suppressed`)} + ${result === "suppressed" ? 1 : 0},
                errors = ${dsql.raw(`${REACTOR_STATE_TABLE}.errors`)} + ${result === "error" ? 1 : 0},
                last_ran_at = excluded.last_ran_at,
                last_error = ${result === "error" ? dsql`excluded.last_error` : dsql.raw("NULL")}`,
    );
};

/**
 * Would a flush touching `changed` have been able to alter what this reactor
 * read? `true` whenever the footprint is unknown — the safety rule this whole
 * module follows is that narrowing is an optimization, never a correctness
 * input (the same rule `read-write-set.ts` states for index ranges).
 *
 * Takes only the footprint, not a whole {@link ReactorState}: the decision reads
 * nothing else, and narrowing the parameter keeps a caller from thinking the
 * digest or the counters influence it.
 * @returns `true` when the reactor must re-run `select`.
 */
const reactorNeedsRun = (state: Pick<ReactorState, "tables"> | undefined, changed: ReadonlySet<string>): boolean => {
    if (state?.tables === undefined) {
        return true;
    }

    return state.tables.some((table) => changed.has(table));
};

export { listReactorStates, migrateReactorState, REACTOR_STATE_TABLE, reactorNeedsRun, readReactorState, writeReactorState };
export type { ReactorDispatchResult, ReactorState, ReactorStats };
