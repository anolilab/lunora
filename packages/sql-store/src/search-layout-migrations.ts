/**
 * One-time migrations of existing search companions to the current layouts:
 * the FTS5 companion's rows written before its rowid map, and the inverted
 * companion's unique key. Each layout exposes its own through
 * `SearchLayout.migrate`, which `ctx-db-search` runs in two modes:
 *
 * - `step`, on every cold start: a bounded share that is safe inside a user
 *   request.
 * - `drain`, from `backfillSqlSearchIndexes`: runs to completion, and reports
 *   what it could not finish.
 */

/* eslint-disable unicorn/prevent-abbreviations -- `SqlCtxExec` is this package's established exec type name. */

// eslint-disable-next-line import/no-extraneous-dependencies -- @lunora/search-core is a devDependency on purpose: packem inlines it into this bundle, so it is not a published runtime dep
import { analyzedSearchText, countSearchTokens, createSearchAnalyzer, FTS_ID_COLUMN, FTS_TOKEN_COLUMN } from "@lunora/search-core";
import type { SearchIndexDefinitionLike, TableDefinitionLike } from "@lunora/shard-engine";
import { ftsPurgeDocument, ftsUnmappedPage, ftsWriteDocument, groupUnmappedRows } from "@lunora/shard-engine";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import type { SqlDialect } from "./dialect";
import { guardFor, invertedUniqueKey, invertedWriteStatements, MYSQL_KEY_ID_PREFIX, purgeStatement, qualified, readSourceRows } from "./search-writes";
import type { SqlCtxExec } from "./sql-exec";
import { createIndexIfNotExists, decodeRow, dropIndexIfExists, indexState, queryAll, queryRun, runInOrder } from "./sql-exec";

/** The companion a migration works on, and what it indexes. */
interface MigrationTarget {
    companion: string;
    definition: TableDefinitionLike;
    index: SearchIndexDefinitionLike;
    tableName: string;
}

/** What a migration could not finish; all zero and `false` when it did. */
interface MigrationReport {
    /** An inverted companion that still lacks its unique key. `drain` only. */
    uniqueKeyMissing: boolean;
    /** A previous build's FTS5 rows left in place because every attempt lost to a concurrent write. */
    unmappedSkipped: number;
}

type MigrationMode = "drain" | "step";

const NOTHING_LEFT: MigrationReport = { uniqueKeyMissing: false, unmappedSkipped: 0 };

/** Warnings already printed in this isolate, so a condition every request sees is reported once. */
const warned = new Set<string>();

const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) {
        return;
    }

    warned.add(key);
    // eslint-disable-next-line no-console -- the only channel a migration has
    console.warn(`[@lunora/sql-store] ${message}`);
};

/** One {@link migrateUnmappedEntries} pass over a page of unmapped rows. */
interface UnmappedPass {
    /** No unmapped rows past this page. */
    done: boolean;
    /** The highest rowid the page covered: where the next page starts. */
    last: number;
    /** Rows of this page still unmapped — each one lost its write to a concurrent one. */
    left: number;
}

/** FTS5 rows rewritten per migration pass — the bound on one cold start's share of it. */
const FTS_UNMAPPED_PAGE_ROWS = 100;

/**
 * Attempts at one page of a previous build's rows before the drain moves past
 * the ones that keep losing to a concurrent write. A loser is left in place:
 * the next cold start's pass retries it, and a write that changes its text
 * drops it anyway.
 */
const UNMAPPED_PAGE_ATTEMPTS = 3;

/**
 * Rewrite one bounded page of the FTS5 rows the rowid map does not know about —
 * a previous build's, including any it wrote during the rollout — from the
 * source table, starting past rowid `after`, and report how the page went (see
 * {@link UnmappedPass}). Once none are left, a pass costs two reads: the source
 * table's existence probe and an empty rowid-range read.
 *
 * Rewriting from the source row, rather than adopting the stored text, is what
 * repairs a document indexed twice: which copy is stale cannot be told from the
 * companion, but the source row says what the entry should be. Each write is
 * guarded like the backfill's; one that loses to a concurrent write leaves its
 * rows in place, and the next pass rewrites them from the newer source row.
 */
const migrateUnmappedEntries = async (exec: SqlCtxExec, dialect: SqlDialect, target: MigrationTarget, after = 0): Promise<UnmappedPass> => {
    const { companion, definition, index, tableName } = target;
    const nothing: UnmappedPass = { done: true, last: after, left: 0 };
    const source = await queryAll(exec, dialect, dialect.tableExists(tableName));

    if (source.length === 0) {
        return nothing;
    }

    const unmapped = await queryAll(exec, dialect, ftsUnmappedPage(companion, FTS_UNMAPPED_PAGE_ROWS, after));

    if (unmapped.length === 0) {
        return nothing;
    }

    const last = Math.max(...unmapped.map((row) => Number(row["rowid"])));
    const byId = groupUnmappedRows(unmapped);
    const sources = await readSourceRows(exec, dialect, tableName, [...byId.keys()]);
    const statements: SQL[] = [];

    for (const [id, unmappedRowids] of byId) {
        const row = sources.get(id);
        const document = row === undefined ? undefined : decodeRow(definition, row);
        // Absent from the source table: its entry goes, unless the row reappears first.
        const guard = guardFor(dialect, tableName, id, row);

        statements.push(
            ...(document
                ? ftsWriteDocument(companion, id, analyzedSearchText(document, index), { guard, unmappedRowids })
                : ftsPurgeDocument(companion, id, { guard, unmappedRowids })),
        );
    }

    // The whole page in one batch: one D1 round trip, not one per document.
    // Each document's statements carry their own guard, so one losing to a
    // concurrent write leaves only its own rows in place.
    await runInOrder(exec, dialect, statements);

    // What lost to a concurrent write stays in the page's range.
    const left = await queryAll(
        exec,
        dialect,
        sql`SELECT COUNT(*) AS ${sql.identifier("n")} FROM ${sql.identifier(companion)} WHERE ${qualified(companion, "rowid")} > ${Math.max(0, after)} AND ${qualified(companion, "rowid")} <= ${last}`,
    );

    return { done: unmapped.length < FTS_UNMAPPED_PAGE_ROWS, last, left: Number(left[0]?.["n"] ?? 0) };
};

/**
 * Rewrite all of a companion's unmapped rows, a page at a time, retrying each
 * page a bounded number of times. Returns how many rows it gave up on.
 */
const drainUnmappedEntries = async (exec: SqlCtxExec, dialect: SqlDialect, target: MigrationTarget): Promise<number> => {
    let after = 0;
    let skipped = 0;

    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- pages are sequential: each starts where the last one ended.
        let pass = await migrateUnmappedEntries(exec, dialect, target, after);

        for (let attempt = 1; pass.left > 0 && attempt < UNMAPPED_PAGE_ATTEMPTS; attempt += 1) {
            // eslint-disable-next-line no-await-in-loop -- a retry re-reads the page's losers from their newer source rows.
            pass = await migrateUnmappedEntries(exec, dialect, target, after);
        }

        if (pass.left > 0) {
            skipped += pass.left;
            // eslint-disable-next-line no-console -- the only channel a backfill pass has
            console.warn(
                `[@lunora/sql-store] search migration of "${target.companion}": ${String(pass.left)} row(s) lost every one of ${String(UNMAPPED_PAGE_ATTEMPTS)} attempts to a concurrent write and were left for a later pass.`,
            );
        }

        if (pass.done) {
            return skipped;
        }

        after = pass.last;
    }
};

/** The FTS5 companion's migration: one page of unmapped rows per cold start, all of them from the backfill. */
const migrateFts5Companion = async (exec: SqlCtxExec, dialect: SqlDialect, target: MigrationTarget, mode: MigrationMode): Promise<MigrationReport> => {
    if (mode === "step") {
        await migrateUnmappedEntries(exec, dialect, target);

        return NOTHING_LEFT;
    }

    return { uniqueKeyMissing: false, unmappedSkipped: await drainUnmappedEntries(exec, dialect, target) };
};

/** The plain `(token, id)` index an inverted companion had before its unique key. */
const legacyTokenIndex = (companion: string): string => `${companion}__btree`;

/**
 * Give a companion its unique key where that is free, from the request path.
 *
 * Runs in every `ensureMigrated`, so it costs one catalog read once the key is
 * there. An EMPTY companion without it — a new one, or one recreated by hand —
 * gets the key at once: building it over no rows takes no time. A non-empty one
 * is left for {@link buildInvertedUniqueKey}, which `backfillSqlSearchIndexes`
 * runs: building over existing rows can take long and can fail on a duplicate,
 * neither of which belongs in a user's request. Writes stay correct without the
 * key — the source-row guard and the re-check converge — so the only cost of
 * waiting is that two racing backfills of one row can still double it.
 *
 * Never throws for the key: a failure here is reported and left to the backfill.
 */
const ensureInvertedUniqueKey = async (exec: SqlCtxExec, dialect: SqlDialect, companion: string): Promise<void> => {
    const key = invertedUniqueKey(dialect, companion);
    const state = await indexState(exec, dialect, companion, key.name);

    if (state === "valid") {
        return;
    }

    if (state === "absent") {
        const anyRow = await queryAll(exec, dialect, sql`SELECT 1 AS ${sql.identifier("present")} FROM ${sql.identifier(companion)} LIMIT 1`);

        if (anyRow.length === 0) {
            try {
                // Not concurrently: over no rows a plain build is instant, and a
                // concurrent one would wait for every open transaction first.
                await createIndexIfNotExists(exec, dialect, { ...key, concurrently: false });
                await dropIndexIfExists(exec, dialect, companion, legacyTokenIndex(companion));

                return;
            } catch (error) {
                // A concurrent request creating the same index is the likely cause, and the one that is fine.
                if ((await indexState(exec, dialect, companion, key.name)) === "valid") {
                    return;
                }

                warnOnce(
                    `${companion}:empty`,
                    `search companion "${companion}": adding its unique key failed (${String(error)}); run backfillSqlSearchIndexes.`,
                );

                return;
            }
        }
    }

    warnOnce(
        `${companion}:missing`,
        `search companion "${companion}" has no usable unique key, so two backfills racing over one row can index it twice. Run backfillSqlSearchIndexes, which adds it.`,
    );
};

/** A document's rows that share one token: `count` copies where the key allows one. */
interface DuplicateGroup {
    count: number;
    id: string;
    token: string;
}

/** Every duplicated `(token, id)` in the companion — one full scan, run only after the key failed on one. */
const findDuplicates = async (exec: SqlCtxExec, dialect: SqlDialect, companion: string): Promise<DuplicateGroup[]> => {
    const id = qualified(companion, FTS_ID_COLUMN);
    const token = qualified(companion, FTS_TOKEN_COLUMN);
    const rows = await queryAll(
        exec,
        dialect,
        sql`SELECT ${id} AS ${sql.identifier("id")}, ${token} AS ${sql.identifier("token")}, COUNT(*) AS ${sql.identifier("n")} FROM ${sql.identifier(companion)} GROUP BY ${id}, ${token} HAVING COUNT(*) > 1`,
    );

    return rows.map((row) => {
        return { count: Number(row["n"]), id: String(row["id"]), token: String(row["token"]) };
    });
};

/** Delete all but one copy of a duplicated `(token, id)`. The copies are identical rows, so which one stays does not matter. */
const keepOneCopy = (dialect: SqlDialect, companion: string, { count, id, token }: DuplicateGroup): SQL => {
    const matches = sql`${qualified(companion, FTS_ID_COLUMN)} = ${id} AND ${qualified(companion, FTS_TOKEN_COLUMN)} = ${token}`;

    switch (dialect.name) {
        case "mysql": {
            return sql`DELETE FROM ${sql.identifier(companion)} WHERE ${matches} LIMIT ${sql.raw(String(count - 1))}`;
        }
        case "postgres": {
            return sql`DELETE FROM ${sql.identifier(companion)} WHERE ctid = ANY (ARRAY(SELECT ctid FROM ${sql.identifier(companion)} WHERE ${matches} OFFSET 1))`;
        }
        default: {
            // node:sqlite tests only; see `invertedWriteStatements`.
            return sql`DELETE FROM ${sql.identifier(companion)} WHERE rowid IN (SELECT rowid FROM ${sql.identifier(companion)} WHERE ${matches} LIMIT -1 OFFSET 1)`;
        }
    }
};

/**
 * Remove the duplicate copies, then rewrite each affected document from its
 * source row, which also drops tokens a racing write left behind. Each rewrite
 * is guarded like any other write; one that loses to a concurrent write leaves
 * the deduplicated rows, which that writer's own write replaces.
 *
 * Two of these running at once can each delete a copy and leave a token with
 * none; the rewrite from the source row puts it back.
 */
const repairDuplicates = async (exec: SqlCtxExec, dialect: SqlDialect, target: MigrationTarget, groups: ReadonlyArray<DuplicateGroup>): Promise<void> => {
    const { companion, definition, index, tableName } = target;

    for (const group of groups) {
        // eslint-disable-next-line no-await-in-loop -- sequential companion writes on the shared connection.
        await queryRun(exec, dialect, keepOneCopy(dialect, companion, group));
    }

    const ids = [...new Set(groups.map((group) => group.id))];
    const sources = await readSourceRows(exec, dialect, tableName, ids);

    for (const id of ids) {
        const row = sources.get(id);
        const document = row === undefined ? undefined : decodeRow(definition, row);

        if (row !== undefined && document) {
            const counts = [...countSearchTokens(analyzedSearchText(document, index), createSearchAnalyzer(index.language))];

            // eslint-disable-next-line no-await-in-loop -- sequential companion writes on the shared connection.
            await runInOrder(exec, dialect, invertedWriteStatements(dialect, companion, id, counts, { row, table: tableName }));

            continue;
        }

        // Gone, or undecodable (which the backfill never indexes either): its rows go.
        // eslint-disable-next-line no-await-in-loop -- sequential companion writes on the shared connection.
        await queryRun(exec, dialect, purgeStatement(companion, id, guardFor(dialect, tableName, id, row)));
    }
};

/**
 * On MySQL, the companion's key columns that compare case- and
 * accent-insensitively — a companion created before the dialect pinned a binary
 * collation. The unique key then treats `Cafe` and `café` as one token: it is
 * refused while both are indexed for one document, and once in place it drops
 * one of them on write. Reported rather than converted: the conversion rebuilds
 * the table, which is the operator's call. Empty elsewhere.
 */
const foldingCollations = async (exec: SqlCtxExec, dialect: SqlDialect, companion: string): Promise<string> => {
    if (dialect.name !== "mysql") {
        return "";
    }

    const collations = await queryAll(
        exec,
        dialect,
        sql`SELECT COLUMN_NAME AS ${sql.identifier("name")}, COLLATION_NAME AS ${sql.identifier("collation")} FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ${companion} AND COLUMN_NAME IN (${FTS_TOKEN_COLUMN}, ${FTS_ID_COLUMN})`,
    );

    return collations
        .filter((row) => !String(row["collation"]).endsWith("_bin"))
        .map(
            (row) =>
                ` Its ${String(row["name"])} column uses ${String(row["collation"])}, which treats values differing only in case or accents as one; convert it with ALTER TABLE \`${companion}\` MODIFY \`${String(row["name"])}\` VARCHAR(768) COLLATE utf8mb4_0900_bin NOT NULL.`,
        )
        .join("");
};

/**
 * On MySQL, how many tokens are held by ids that agree on the first
 * {@link MYSQL_KEY_ID_PREFIX} characters the key covers — which the key cannot
 * tell apart, so it is refused while they exist. Zero elsewhere.
 */
const prefixSharingTokens = async (exec: SqlCtxExec, dialect: SqlDialect, companion: string): Promise<number> => {
    if (dialect.name !== "mysql") {
        return 0;
    }

    const id = qualified(companion, FTS_ID_COLUMN);
    const rows = await queryAll(
        exec,
        dialect,
        sql`SELECT COUNT(*) AS ${sql.identifier("n")} FROM (SELECT 1 AS ${sql.identifier("x")} FROM ${sql.identifier(companion)} GROUP BY LEFT(${id}, ${sql.raw(String(MYSQL_KEY_ID_PREFIX))}), ${qualified(companion, FTS_TOKEN_COLUMN)} HAVING COUNT(DISTINCT ${id}) > 1) AS ${sql.identifier("shared")}`,
    );

    return Number(rows[0]?.["n"] ?? 0);
};

/**
 * One attempt at the unique key: `valid` once it is in place, `refused` when a
 * duplicate in the companion stopped it, `built` when the build went through
 * (the next attempt confirms it). Any error that is not a duplicate propagates.
 *
 * After a failed build the catalog is read before the error: a valid index
 * there was another run building the same one, whose catalog row collided with
 * ours. An invalid one is what our failed concurrent build left — or, rarely,
 * another run's still in progress, which then fails and retries — and is
 * dropped, since `IF NOT EXISTS` would take it for the real one.
 */
const tryUniqueKey = async (exec: SqlCtxExec, dialect: SqlDialect, companion: string): Promise<"built" | "refused" | "valid"> => {
    const key = invertedUniqueKey(dialect, companion);
    const state = await indexState(exec, dialect, companion, key.name);

    if (state === "valid") {
        return "valid";
    }

    if (state === "invalid") {
        await dropIndexIfExists(exec, dialect, companion, key.name);
    }

    try {
        await createIndexIfNotExists(exec, dialect, key);

        return "built";
    } catch (error) {
        const after = await indexState(exec, dialect, companion, key.name);

        if (after === "valid") {
            return "valid";
        }

        if (after === "invalid") {
            await dropIndexIfExists(exec, dialect, companion, key.name);
        }

        if (!dialect.isUniqueViolation(error)) {
            throw error;
        }

        return "refused";
    }
};

/** Attempts at the key, each after repairing what the previous one failed on. */
const UNIQUE_KEY_ATTEMPTS = 3;

/**
 * Add the inverted companion's unique key, from `backfillSqlSearchIndexes`.
 * Returns whether the key is in place.
 *
 * The key is tried first, because most companions hold no duplicate and then
 * one statement finishes the job. On Postgres it builds concurrently, so writes
 * continue while it does; a failed concurrent build leaves an invalid index,
 * which `IF NOT EXISTS` would take for the real one, so an invalid index is
 * dropped and built again (see {@link tryUniqueKey}). When a duplicate in the
 * companion refuses it, the duplicates are found in one scan, repaired from
 * their source rows, and the key tried again. Any other error — a lock or
 * statement timeout — propagates to the caller: the operator's call, never a
 * user's request.
 */
const buildInvertedUniqueKey = async (exec: SqlCtxExec, dialect: SqlDialect, target: MigrationTarget): Promise<boolean> => {
    const { companion } = target;
    const folding = await foldingCollations(exec, dialect, companion);
    let refusal = "";

    if (folding !== "") {
        // eslint-disable-next-line no-console -- the only channel a backfill pass has
        console.warn(`[@lunora/sql-store] search companion "${companion}" folds case and accents in its unique key.${folding}`);
    }

    for (let attempt = 0; attempt < UNIQUE_KEY_ATTEMPTS; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- each attempt starts from what the catalog holds now
        const outcome = await tryUniqueKey(exec, dialect, companion);

        if (outcome === "valid") {
            // eslint-disable-next-line no-await-in-loop -- sequential DDL on the shared connection
            await dropIndexIfExists(exec, dialect, companion, legacyTokenIndex(companion));

            return true;
        }

        if (outcome === "refused") {
            // eslint-disable-next-line no-await-in-loop -- one scan, after the key refused a duplicate
            const duplicates = await findDuplicates(exec, dialect, companion);

            if (duplicates.length > 0) {
                // eslint-disable-next-line no-await-in-loop -- the repair has to finish before the retry
                await repairDuplicates(exec, dialect, target, duplicates);
            } else {
                // eslint-disable-next-line no-await-in-loop -- only reached once the key has been refused
                const shared = await prefixSharingTokens(exec, dialect, companion);

                refusal =
                    shared > 0
                        ? ` ${String(shared)} token(s) are held by document ids that agree on their first ${String(MYSQL_KEY_ID_PREFIX)} characters, which the key cannot tell apart; shorten those ids.`
                        : folding;
            }
        }
    }

    // One last look: the final attempt's build may have been the one that took.
    if ((await indexState(exec, dialect, companion, invertedUniqueKey(dialect, companion).name)) === "valid") {
        await dropIndexIfExists(exec, dialect, companion, legacyTokenIndex(companion));

        return true;
    }

    // eslint-disable-next-line no-console -- the only channel a backfill pass has
    console.warn(
        `[@lunora/sql-store] search companion "${companion}" still has no unique key after ${String(UNIQUE_KEY_ATTEMPTS)} attempts: writes keep working, but two backfills racing over one row can index it twice.${refusal}`,
    );

    return false;
};

/** The inverted companion's migration: nothing per cold start (see {@link ensureInvertedUniqueKey}), the key from the backfill. */
const migrateInvertedCompanion = async (exec: SqlCtxExec, dialect: SqlDialect, target: MigrationTarget, mode: MigrationMode): Promise<MigrationReport> => {
    if (mode === "step") {
        return NOTHING_LEFT;
    }

    return { uniqueKeyMissing: !(await buildInvertedUniqueKey(exec, dialect, target)), unmappedSkipped: 0 };
};

export type { MigrationMode, MigrationReport, MigrationTarget, UnmappedPass };
export { ensureInvertedUniqueKey, migrateFts5Companion, migrateInvertedCompanion, migrateUnmappedEntries };
