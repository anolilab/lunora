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
 */

import { sql as dsql } from "drizzle-orm";

import type { SqlExec, WriteHook } from "./ctx-db";
import { runDrizzle } from "./do-exec";
import { DOC_COLUMN, tryRowToDocument } from "./do-sql";

/** Reserved table holding one backfill-progress row per vectorized table. */
const VECTOR_BACKFILL_STATE_TABLE = "__lunora_vector_backfill";

/**
 * Rows per page. Each row costs an embed plus an upsert per index, so this is
 * sized to a request's subrequest budget, not to SQLite.
 */
const VECTOR_BACKFILL_PAGE_ROWS = 100;

/** Rows embedded at once within a page — the same bound the write hook's fan-out uses. */
const VECTOR_BACKFILL_CONCURRENCY = 8;

/** A vectorized table to walk, and a fingerprint of the index config its vectors were built with. */
interface VectorBackfillTarget {
    profile: string;
    table: string;
}

interface VectorBackfillProgress {
    /** `false` when the page budget ran out first — call again to resume. */
    done: boolean;
    /** Pages walked by this call. */
    pages: number;
    /** Rows handed to the sync hook by this call. */
    rows: number;
}

/**
 * Run `read` where no write can interleave, then `work` on its result, ordered
 * after the post-commit hooks of every write committed before `read` and before
 * those of every write committed after it. Rejects with `work`'s error.
 */
type OrderedAfterWrites = <T>(read: () => T, work: (value: T) => Promise<void>) => Promise<void>;

interface VectorBackfillState {
    cursor: string | undefined;
    done: boolean;
    profile: string | undefined;
}

const migrateVectorBackfillState = (sql: SqlExec): void => {
    runDrizzle(
        sql,
        dsql`CREATE TABLE IF NOT EXISTS ${dsql.identifier(VECTOR_BACKFILL_STATE_TABLE)} (${dsql.identifier("tbl")} TEXT PRIMARY KEY, ${dsql.identifier("cursor")} TEXT, ${dsql.identifier("done")} INTEGER NOT NULL DEFAULT 0, ${dsql.identifier("profile")} TEXT)`,
    );
};

const readState = (sql: SqlExec, table: string): VectorBackfillState => {
    const row = runDrizzle<{ cursor: unknown; done: unknown; profile: unknown }>(
        sql,
        dsql`SELECT ${dsql.identifier("cursor")}, ${dsql.identifier("done")}, ${dsql.identifier("profile")} FROM ${dsql.identifier(VECTOR_BACKFILL_STATE_TABLE)} WHERE ${dsql.identifier("tbl")} = ${table}`,
    ).toArray()[0];

    return {
        cursor: typeof row?.cursor === "string" ? row.cursor : undefined,
        done: Number(row?.done ?? 0) === 1,
        profile: typeof row?.profile === "string" ? row.profile : undefined,
    };
};

const writeState = (sql: SqlExec, table: string, state: VectorBackfillState & { profile: string }): void => {
    // eslint-disable-next-line unicorn/no-null -- SQL bind value: "no page has run yet" is a NULL column, not undefined
    const cursor = state.cursor ?? null;

    runDrizzle(
        sql,
        dsql`INSERT INTO ${dsql.identifier(VECTOR_BACKFILL_STATE_TABLE)} (${dsql.identifier("tbl")}, ${dsql.identifier("cursor")}, ${dsql.identifier("done")}, ${dsql.identifier("profile")}) VALUES (${table}, ${cursor}, ${state.done ? 1 : 0}, ${state.profile}) ON CONFLICT (${dsql.identifier("tbl")}) DO UPDATE SET ${dsql.identifier("cursor")} = excluded.${dsql.identifier("cursor")}, ${dsql.identifier("done")} = excluded.${dsql.identifier("done")}, ${dsql.identifier("profile")} = excluded.${dsql.identifier("profile")}`,
    );
};

/** One page of `table` past `cursor`, in `id` order, decoded. Unparseable documents are skipped but still advance the cursor. */
const readPage = (
    sql: SqlExec,
    table: string,
    cursor: string | undefined,
): { documents: { doc: Record<string, unknown>; id: string }[]; lastId: string | undefined; size: number } => {
    const limit = dsql.raw(String(VECTOR_BACKFILL_PAGE_ROWS));
    const rows = runDrizzle(
        sql,
        cursor === undefined
            ? dsql`SELECT id, _creationTime, ${dsql.identifier(DOC_COLUMN)} FROM ${dsql.identifier(table)} ORDER BY id ASC LIMIT ${limit}`
            : dsql`SELECT id, _creationTime, ${dsql.identifier(DOC_COLUMN)} FROM ${dsql.identifier(table)} WHERE id > ${cursor} ORDER BY id ASC LIMIT ${limit}`,
    ).toArray();
    const documents: { doc: Record<string, unknown>; id: string }[] = [];
    let lastId = cursor;

    for (const row of rows) {
        if (typeof row["id"] !== "string") {
            continue;
        }

        lastId = row["id"];

        const record = tryRowToDocument(row);

        if (record) {
            documents.push({ doc: record, id: lastId });
        }
    }

    return { documents, lastId, size: rows.length };
};

/**
 * Hand every document to `sync` as an `update`, at most
 * {@link VECTOR_BACKFILL_CONCURRENCY} at a time. Settles every call before
 * rethrowing the first failure: a page that "failed" while an upsert was still in
 * flight would release the chain, and that upsert could land after the next
 * write's hook for the same row.
 */
const syncPage = async (table: string, documents: ReadonlyArray<{ doc: Record<string, unknown>; id: string }>, sync: WriteHook): Promise<void> => {
    for (let start = 0; start < documents.length; start += VECTOR_BACKFILL_CONCURRENCY) {
        // eslint-disable-next-line no-await-in-loop -- one bounded batch at a time is the point
        const settled = await Promise.allSettled(
            documents.slice(start, start + VECTOR_BACKFILL_CONCURRENCY).map(async ({ doc, id }) => sync({ doc, id, op: "update", table })),
        );
        const failure = settled.find((result) => result.status === "rejected");

        if (failure) {
            throw failure.reason;
        }
    }
};

/**
 * Walk each target table forward through `sync` — the same hook live writes use,
 * so a soft-deleted row is purged rather than indexed and a cleared field drops
 * its vector — for at most `maxPages` pages (default 1).
 *
 * A target whose recorded profile differs from its current one (an index added,
 * renamed, re-pointed at another field, or given new dimensions/metric/metadata)
 * restarts from the top; its existing vectors are overwritten in place, never
 * emptied first. An embedder change the profile cannot see (same source text,
 * different model) needs `restart: true`, which resets every target once.
 *
 * The cursor advances only after a page's hooks all succeeded, so a failed page
 * is retried by the next call rather than skipped.
 */
const backfillVectorIndexes = async (
    sql: SqlExec,
    targets: ReadonlyArray<VectorBackfillTarget>,
    sync: WriteHook,
    options: { maxPages?: number; ordered: OrderedAfterWrites; restart?: boolean },
): Promise<VectorBackfillProgress> => {
    migrateVectorBackfillState(sql);

    // Reset every target up front, not as the walk reaches it: the page budget can
    // run out before the later ones, and the call that resumes them carries no
    // `restart` — they would read as finished and never be re-embedded.
    if (options.restart === true) {
        for (const { profile, table } of targets) {
            writeState(sql, table, { cursor: undefined, done: false, profile });
        }
    }

    const maxPages = options.maxPages ?? 1;
    let pages = 0;
    let rows = 0;

    for (const { profile, table } of targets) {
        const recorded = readState(sql, table);
        let state: VectorBackfillState & { profile: string } =
            recorded.profile === profile ? { ...recorded, profile } : { cursor: undefined, done: false, profile };

        while (!state.done) {
            if (pages >= maxPages) {
                return { done: false, pages, rows };
            }

            const { cursor } = state;
            let page: ReturnType<typeof readPage> | undefined;

            // eslint-disable-next-line no-await-in-loop -- pages are sequential: each resumes past the last
            await options.ordered(
                () => readPage(sql, table, cursor),
                async (read) => {
                    page = read;
                    await syncPage(table, read.documents, sync);
                },
            );

            pages += 1;
            rows += page?.documents.length ?? 0;
            state = { cursor: page?.lastId ?? cursor, done: (page?.size ?? 0) < VECTOR_BACKFILL_PAGE_ROWS, profile };
            writeState(sql, table, state);
        }
    }

    return { done: true, pages, rows };
};

export type { OrderedAfterWrites, VectorBackfillProgress, VectorBackfillTarget };
export { backfillVectorIndexes, VECTOR_BACKFILL_PAGE_ROWS };
