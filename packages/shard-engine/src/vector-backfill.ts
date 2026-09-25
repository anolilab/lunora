/**
 * Index the rows that predate a vector index — the out-of-band twin of the
 * write-through sync hook, which only ever sees rows written after the index was
 * declared.
 *
 * Paged and resumable: a page embeds each row through a remote model and writes
 * it to an external index with its own request limits, so a large table cannot be
 * walked inside one request. Progress is recorded per table; the next call
 * resumes past the last id the previous one finished.
 *
 * The one hard obligation is not to overwrite a newer vector with an older one.
 * A page reads rows and then spends seconds embedding them; a write committed in
 * that window has its own hook, and if the page's upsert landed after that hook
 * the row would carry the vector of text it no longer has — or, for a delete, a
 * vector for a row that is gone. The host's `ordered` primitive closes it: the
 * page is read where no write can interleave and its work joins the same
 * commit-ordered chain the write hooks drain on, so every hook of an earlier
 * write runs before the page and every hook of a later one runs after it.
 *
 * The price of that ordering is that a page HOLDS the chain: every mutation that
 * commits while it runs has its own hook queued behind it, and its response
 * waits for that hook. So a page is small ({@link VECTOR_BACKFILL_PAGE_ROWS}
 * rows, embedded with bounded concurrency and written with one batch call per
 * index) — a few seconds with a typical remote embedder, well under the host's
 * after-commit wait bound.
 */

import { isLunoraError } from "@lunora/errors";
// eslint-disable-next-line import/no-extraneous-dependencies -- @lunora/search-core is a devDependency on purpose: packem inlines it into this bundle, so it is not a published runtime dep
import { planBackfillPass } from "@lunora/search-core";
import { sql as dsql } from "drizzle-orm";

import type { SqlExec } from "./ctx-db";
import { readKeysetPage } from "./ctx-db-backfill";
import { readBackfillState } from "./ctx-db-search-state";
import { runDrizzle } from "./do-exec";
import { tryRowToDocument } from "./do-sql";

/** Reserved table holding one backfill-progress row per vectorized table, keyed `companion` like the search state. */
const VECTOR_BACKFILL_STATE_TABLE = "__lunora_vector_backfill";

/**
 * Rows per page. Sized to how long the page holds the shard's write-hook chain,
 * not to SQLite: at the hook fan-out's concurrency of 8 and ~300 ms per remote
 * embed, 50 rows is about two seconds.
 */
const VECTOR_BACKFILL_PAGE_ROWS = 50;

/**
 * Most pages one call may run — about a thousand rows. A call is one request,
 * and a caller asking for more is asking for a request that outlives its budget;
 * it repeats the call instead.
 */
const VECTOR_BACKFILL_MAX_PAGES = 20;

/** How many failed row ids one call reports back. The count is always exact. */
const FAILED_IDS_REPORTED = 20;

/**
 * Consecutive calls a page may fail as a whole, at the same cursor, before its
 * rows are recorded as failed and the walk moves past it. A page whose every row
 * fails the same way on each try (each one refused, with no status to say so)
 * would otherwise hold the cursor for good, and every table after it with it.
 * A failure known to be transient (`SERVICE_UNAVAILABLE`) never counts.
 */
const VECTOR_BACKFILL_MAX_STRIKES = 3;

/** A vectorized table to walk, and a fingerprint of the index config its vectors were built with. */
interface VectorBackfillTarget {
    profile: string;
    table: string;
}

interface VectorBackfillProgress {
    /** `false` when the page budget ran out, or a page failed — call again to resume. */
    done: boolean;

    /**
     * Set when a page failed as a whole (the embedder or Vectorize unreachable).
     * That page's cursor was held, so the next call retries it. A page that keeps
     * failing without a transient cause is written off on its third consecutive
     * call: its rows land in `failed` and the walk moves on.
     */
    error?: string;

    /** Rows this call could not index and moved past — a bad source value, rejected text, refused metadata. */
    failed: number;

    /** The first few of those rows' ids. */
    failedIds: string[];

    /** Row-walking pages this call ran. */
    pages: number;

    /** Rows this call walked, failed ones included. */
    rows: number;
}

/**
 * Index one page of rows; resolves with the rows that failed on their own and
 * rejects when the whole page failed. `@lunora/bindings/vectors`'
 * `createVectorBackfillSync` builds it.
 */
type VectorPageSync = (
    table: string,
    rows: ReadonlyArray<{ doc: Record<string, unknown>; id: string }>,
) => Promise<ReadonlyArray<{ error: unknown; id: string }>>;

/**
 * Run `read` where no write can interleave, then `work` on its result, ordered
 * after the post-commit hooks of every write committed before `read` and before
 * those of every write committed after it. Resolves with `work`'s result.
 */
type OrderedAfterWrites = <T, U>(read: () => T, work: (value: T) => Promise<U>) => Promise<U>;

interface VectorPage {
    documents: { doc: Record<string, unknown>; id: string }[];
    lastId: string | undefined;
    /** Rows past this page exist. Read by peeking one row, so a table that ends on a page boundary finishes on that page. */
    more: boolean;
    unparseable: string[];
}

const migrateVectorBackfillState = (sql: SqlExec): void => {
    runDrizzle(
        sql,
        dsql`CREATE TABLE IF NOT EXISTS ${dsql.identifier(VECTOR_BACKFILL_STATE_TABLE)} (${dsql.identifier("companion")} TEXT PRIMARY KEY, ${dsql.identifier("cursor")} TEXT, ${dsql.identifier("done")} INTEGER NOT NULL DEFAULT 0, ${dsql.identifier("profile")} TEXT, ${dsql.identifier("strikes")} INTEGER NOT NULL DEFAULT 0)`,
    );

    // A table created by an earlier build has no `strikes` column, and
    // `CREATE TABLE IF NOT EXISTS` will not add one.
    try {
        runDrizzle(sql, dsql`ALTER TABLE ${dsql.identifier(VECTOR_BACKFILL_STATE_TABLE)} ADD COLUMN ${dsql.identifier("strikes")} INTEGER NOT NULL DEFAULT 0`);
    } catch {
        // Already present (or the table was just created with it).
    }
};

const readStrikes = (sql: SqlExec, table: string): number => {
    const [row] = runDrizzle<{ strikes: number }>(
        sql,
        dsql`SELECT ${dsql.identifier("strikes")} FROM ${dsql.identifier(VECTOR_BACKFILL_STATE_TABLE)} WHERE ${dsql.identifier("companion")} = ${table}`,
    ).toArray();

    return row?.strikes ?? 0;
};

/** `strikes` counts the calls that failed at `cursor`; every other write resets it. */
const writeState = (sql: SqlExec, table: string, cursor: string | undefined, done: boolean, profile: string, strikes = 0): void => {
    // eslint-disable-next-line unicorn/no-null -- SQL bind value: "no page has run yet" is a NULL column, not undefined
    const cursorValue = cursor ?? null;

    runDrizzle(
        sql,
        dsql`INSERT INTO ${dsql.identifier(VECTOR_BACKFILL_STATE_TABLE)} (${dsql.identifier("companion")}, ${dsql.identifier("cursor")}, ${dsql.identifier("done")}, ${dsql.identifier("profile")}, ${dsql.identifier("strikes")}) VALUES (${table}, ${cursorValue}, ${done ? 1 : 0}, ${profile}, ${strikes}) ON CONFLICT (${dsql.identifier("companion")}) DO UPDATE SET ${dsql.identifier("cursor")} = excluded.${dsql.identifier("cursor")}, ${dsql.identifier("done")} = excluded.${dsql.identifier("done")}, ${dsql.identifier("profile")} = excluded.${dsql.identifier("profile")}, ${dsql.identifier("strikes")} = excluded.${dsql.identifier("strikes")}`,
    );
};

const readPage = (sql: SqlExec, table: string, cursor: string | undefined): VectorPage => {
    const rows = readKeysetPage(sql, table, cursor, VECTOR_BACKFILL_PAGE_ROWS + 1);
    const page: VectorPage = { documents: [], lastId: cursor, more: rows.length > VECTOR_BACKFILL_PAGE_ROWS, unparseable: [] };

    for (const row of rows.slice(0, VECTOR_BACKFILL_PAGE_ROWS)) {
        if (typeof row["id"] !== "string") {
            continue;
        }

        page.lastId = row["id"];

        const record = tryRowToDocument(row);

        if (record) {
            page.documents.push({ doc: record, id: page.lastId });
        } else {
            page.unparseable.push(page.lastId);
        }
    }

    return page;
};

/**
 * Record one whole-page failure at `cursor`. Resolves `{ error }` while the page
 * is still to be retried; on the {@link VECTOR_BACKFILL_MAX_STRIKES}th consecutive
 * failure at that cursor, resolves with the page read again and every row of it
 * as failed, for the caller to move past like any other page.
 *
 * `SERVICE_UNAVAILABLE` is the failure known to be transient — the embedder or
 * Vectorize said so, or the host stopped waiting on a stalled chain — so it holds
 * the cursor without counting: an outage must never write a page off.
 */
const strike = (
    sql: SqlExec,
    table: string,
    cursor: string | undefined,
    profile: string,
    error: unknown,
): { error: string } | { failedIds: string[]; page: VectorPage } => {
    const message = error instanceof Error ? error.message : String(error);

    if (isLunoraError(error) && error.code === "SERVICE_UNAVAILABLE") {
        return { error: message };
    }

    // Only strikes at THIS cursor under THIS profile count: after a profile
    // change the walk restarts at the top while the row still holds the old walk's.
    const state = readBackfillState(sql, VECTOR_BACKFILL_STATE_TABLE, table);
    const strikes = (state.profile === profile && state.cursor === cursor ? readStrikes(sql, table) : 0) + 1;

    if (strikes < VECTOR_BACKFILL_MAX_STRIKES) {
        writeState(sql, table, cursor, false, profile, strikes);

        return { error: message };
    }

    const page = readPage(sql, table, cursor);
    const failedIds = [...page.documents.map((document) => document.id), ...page.unparseable];

    // eslint-disable-next-line no-console -- the same channel the row failures take
    console.warn(
        `[@lunora/shard-engine] vector backfill: a page of "${table}" failed ${String(strikes)} times in a row; its ${String(failedIds.length)} row(s) are recorded as failed:`,
        error,
    );

    return { failedIds, page };
};

/**
 * Read and sync one page on the host's ordered path. Resolves with the page and
 * the ids of rows that could not be indexed, or with `error` when the page failed
 * as a whole and is to be retried — the caller then holds the cursor. A page
 * written off by {@link strike} resolves like any other, every row failed.
 */
const runPage = async (
    sql: SqlExec,
    target: VectorBackfillTarget,
    cursor: string | undefined,
    sync: VectorPageSync,
    ordered: OrderedAfterWrites,
): Promise<{ error: string } | { failedIds: string[]; page: VectorPage }> => {
    const { profile, table } = target;

    try {
        const { failures, page } = await ordered(
            () => readPage(sql, table, cursor),
            async (read) => {
                return { failures: await sync(table, read.documents), page: read };
            },
        );

        if (failures.length > 0) {
            // eslint-disable-next-line no-console -- the live hook logs its failures the same way; this is their backfill twin
            console.warn(`[@lunora/shard-engine] vector backfill: ${String(failures.length)} row(s) of "${table}" could not be indexed:`, failures);
        }

        return { failedIds: [...page.unparseable, ...failures.map((failure) => failure.id)], page };
    } catch (error) {
        return strike(sql, table, cursor, profile, error);
    }
};

/**
 * Walk each target table forward through `sync` for at most `maxPages` pages
 * (default 1).
 *
 * A target whose recorded profile differs from its current one (an index added,
 * renamed, re-pointed at another field, or given new dimensions/metric/metadata/
 * declared model) restarts from the top — the shared {@link planBackfillPass}
 * decides, as it does for search. Existing vectors are overwritten in place, never
 * emptied first. A change the profile cannot see (an `embed` swap with no declared
 * `model`) needs `restart: true`, which resets every target up front.
 *
 * Two kinds of failure, handled oppositely. A row that fails on its own is
 * counted, reported and moved past: it would fail on every retry, and holding
 * the cursor on it would stop this table — and every table after it — for good.
 * A page that fails as a whole holds its cursor and ends the call with `error`
 * set, so the next call retries it — up to {@link VECTOR_BACKFILL_MAX_STRIKES}
 * consecutive calls, after which its rows are recorded as failed and the walk
 * moves on (see {@link strike}). Either way the counts so far are returned.
 */
const backfillVectorIndexes = async (
    sql: SqlExec,
    targets: ReadonlyArray<VectorBackfillTarget>,
    sync: VectorPageSync,
    options: { maxPages?: number; ordered: OrderedAfterWrites; restart?: boolean },
): Promise<VectorBackfillProgress> => {
    migrateVectorBackfillState(sql);

    // Reset every target up front, not as the walk reaches it: the page budget can
    // run out before the later ones, and the call that resumes them carries no
    // `restart` — they would read as finished and never be re-embedded.
    if (options.restart === true) {
        for (const { profile, table } of targets) {
            writeState(sql, table, undefined, false, profile);
        }
    }

    const maxPages = Math.min(options.maxPages ?? 1, VECTOR_BACKFILL_MAX_PAGES);
    const progress: VectorBackfillProgress = { done: false, failed: 0, failedIds: [], pages: 0, rows: 0 };

    for (const { profile, table } of targets) {
        const pass = planBackfillPass(readBackfillState(sql, VECTOR_BACKFILL_STATE_TABLE, table), profile);
        let { cursor } = pass;
        let done = pass.finished;

        while (!done) {
            if (progress.pages >= maxPages) {
                return progress;
            }

            // eslint-disable-next-line no-await-in-loop -- pages are sequential: each resumes past the last
            const outcome = await runPage(sql, { profile, table }, cursor, sync, options.ordered);

            if ("error" in outcome) {
                return { ...progress, error: outcome.error };
            }

            const { failedIds, page } = outcome;
            const walked = page.documents.length + page.unparseable.length;

            progress.pages += walked > 0 ? 1 : 0;
            progress.rows += walked;
            progress.failed += failedIds.length;
            progress.failedIds = [...progress.failedIds, ...failedIds].slice(0, FAILED_IDS_REPORTED);

            cursor = page.lastId;
            done = !page.more;
            writeState(sql, table, cursor, done, profile);
        }
    }

    return { ...progress, done: true };
};

export type { VectorBackfillProgress, VectorBackfillTarget, VectorPageSync };
export { backfillVectorIndexes, VECTOR_BACKFILL_MAX_PAGES, VECTOR_BACKFILL_PAGE_ROWS };
