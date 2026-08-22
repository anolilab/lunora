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

/** What a reactor observed on its last run. */
interface ReactorState {
    /** Digest of the `select` result the reactor last ran against. */
    digest: string;

    /**
     * Tables that run read. A later flush touching none of them cannot have
     * changed the result, so `select` is not re-run.
     *
     * `undefined` means "not known" — never "none". A reactor that has never run,
     * or whose row predates this column, must be treated as touching everything.
     */
    tables?: ReadonlyArray<string>;
}

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
            tables TEXT NOT NULL
        )`,
    );
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
const readReactorState = (sql: SqlExec, path: string): ReactorState | undefined => {
    const [row] = runDrizzle<{ digest: string; tables: string }>(
        sql,
        dsql`SELECT digest, tables FROM ${dsql.identifier(REACTOR_STATE_TABLE)} WHERE path = ${path}`,
    );

    if (row === undefined || typeof row.digest !== "string") {
        return undefined;
    }

    return { digest: row.digest, tables: parseTables(row.tables) };
};

/** Record what a reactor run observed, replacing any prior baseline. */
const writeReactorState = (sql: SqlExec, path: string, digest: string, tables: ReadonlyArray<string>): void => {
    runDrizzle(
        sql,
        dsql`INSERT INTO ${dsql.identifier(REACTOR_STATE_TABLE)} (path, digest, tables) VALUES (${path}, ${digest}, ${JSON.stringify([...tables])})
             ON CONFLICT(path) DO UPDATE SET digest = excluded.digest, tables = excluded.tables`,
    );
};

/**
 * Would a flush touching `changed` have been able to alter what this reactor
 * read? `true` whenever the footprint is unknown — the safety rule this whole
 * module follows is that narrowing is an optimization, never a correctness
 * input (the same rule `read-write-set.ts` states for index ranges).
 * @returns `true` when the reactor must re-run `select`.
 */
const reactorNeedsRun = (state: ReactorState | undefined, changed: ReadonlySet<string>): boolean => {
    if (state?.tables === undefined) {
        return true;
    }

    return state.tables.some((table) => changed.has(table));
};

export { migrateReactorState, REACTOR_STATE_TABLE, reactorNeedsRun, readReactorState, writeReactorState };
export type { ReactorState };
