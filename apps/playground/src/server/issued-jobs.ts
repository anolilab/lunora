import type { D1DatabaseLike } from "@lunora/d1";

/**
 * The record of which job ids `/test/schedule` actually handed out.
 *
 * `/test/job-status` cannot read a completed job off the scheduler — the
 * SchedulerDO deletes a job's rows the moment it succeeds — so "the scheduler
 * has no record" says nothing on its own: it is equally the answer for a job
 * that executed, an id that was mistyped, and an id that was never scheduled.
 * Answering `executed` to all three lets a spec polling the wrong id pass, so
 * the route needs to know, independently, whether it ever issued the id.
 *
 * In D1, not a module-scope `Set`, and the difference is load-bearing.
 * Cloudflare does not guarantee that two requests reach the same Worker
 * isolate, so a `Set` is written by whichever isolate served `/test/schedule`
 * and is empty in whichever one serves `/test/job-status`. That answers
 * `unknown` for a job running perfectly well — the same defect as the invented
 * `executed` this record exists to prevent, merely inverted: both are the route
 * reading a verdict out of an absence it has no standing to interpret. The
 * binding is shared by every isolate, so the record has to live there.
 *
 * Its own module because the worker entry imports `cloudflare:workers`
 * transitively and cannot be loaded outside workerd; this file is dependency-free
 * beyond a structural D1 type, so the store can be tested directly.
 */

/** Where the issued ids live. Not `sqlite_%` / `_cf_%` / `d1_%`, so `/test/reset` clears it with everything else — a fresh run starts with no history. */
const ISSUED_JOBS_TABLE = "_e2e_issued_jobs";

/**
 * Create the table if this is the first call in this database.
 *
 * Done on read as well as on write: the reader may be a different isolate that
 * has never scheduled anything, and on a database where nothing ever has, the
 * table genuinely does not exist yet. Creating it there costs one statement and
 * keeps "no table" from having to be special-cased as an error.
 */
const ensureTable = async (database: D1DatabaseLike): Promise<void> => {
    await database.prepare(`CREATE TABLE IF NOT EXISTS "${ISSUED_JOBS_TABLE}" ("id" TEXT PRIMARY KEY)`).run();
};

/** Record that this id was really issued. Idempotent, so a retried schedule is not an error. */
export const rememberIssuedJob = async (database: D1DatabaseLike, jobId: string): Promise<void> => {
    await ensureTable(database);
    await database.prepare(`INSERT OR IGNORE INTO "${ISSUED_JOBS_TABLE}" ("id") VALUES (?)`).bind(jobId).run();
};

/** Whether `/test/schedule` minted this id, in this database, at any point since the last reset. */
export const wasJobIssued = async (database: D1DatabaseLike, jobId: string): Promise<boolean> => {
    await ensureTable(database);

    // Qualified `"t"."id"`, never a bare `"id"`: workerd and D1 build SQLite
    // with double-quoted strings enabled, so a quoted name that resolves to
    // nothing becomes a string LITERAL instead of raising — a column that
    // silently stopped resolving would compare the literal to itself and match
    // every row, reporting every id as issued.
    const row = await database.prepare(`SELECT "t"."id" FROM "${ISSUED_JOBS_TABLE}" AS "t" WHERE "t"."id" = ?`).bind(jobId).first<{ id: string }>();

    return row !== null;
};

export { ISSUED_JOBS_TABLE };
