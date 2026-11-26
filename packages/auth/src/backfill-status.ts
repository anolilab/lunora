import type { BackfillExecutor, DuplicateRow } from "./canonical-email";
import { authCanonicalEmailColumn, BACKFILL_STATE_TABLE, canonicalEmail, duplicateRows, MAX_REPORTED_DUPLICATES, quote } from "./canonical-email";
import type { LunoraAuthOptions } from "./create-auth";
import { resolveAuthOptions } from "./create-auth";
import { invitationEmailColumns } from "./invitation-email-backfill";

/** Where the canonical-email backfill stands, read from the database rather than from a past run. */
interface CanonicalEmailBackfillStatus {
    /**
     * Unfilled rows whose canonical value another account already holds: the backfill will never fill
     * them, and only an operator can say which account keeps the address. At most
     * {@link MAX_REPORTED_DUPLICATES}, taken from the first unfilled rows; see `truncated`.
     */
    duplicates: DuplicateRow[];

    /** A pass stopped part-way and saved its position; the next `prepareAuthData` / `ensureMigrated` call resumes it. */
    inProgress: boolean;

    /** Whether more unfilled rows exist than were checked for `duplicates`. */
    truncated: boolean;

    /** Rows whose `emailCanonical` is still `NULL`: duplicates, and rows a pass has not reached yet. */
    unfilled: number;
}

/** Where each of Lunora's auth backfills stands; a key is absent when its table is not configured. */
interface AuthBackfillStatus {
    canonicalEmail?: CanonicalEmailBackfillStatus;
    invitationEmail?: { inProgress: boolean };
}

/** Whether the backfill named `name` has a saved position. A missing state table means no pass has started. */
const hasSavedPosition = async (executor: BackfillExecutor, name: string): Promise<boolean> => {
    // Checked rather than caught, so a failed read reaches the caller instead of reading as "not in progress".
    const tables = await executor.all(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, [BACKFILL_STATE_TABLE]);

    if (tables.length === 0) {
        return false;
    }

    const rows = await executor.all(`SELECT 1 FROM ${quote(BACKFILL_STATE_TABLE)} WHERE "name" = ?`, [name]);

    return rows.length > 0;
};

/**
 * Report where the canonical-email and invitation-email backfills stand, for an admin route or an
 * operator script: how many `user` rows are still unfilled, which of them another account blocks
 * (with that account's id), and whether a pass is part-way.
 *
 * Read-only, and bounded: at most five statements for the canonical email and two for invitations. SQLite
 * only (it reads `rowid`, `json_each` and `sqlite_master`): use the executor over the D1 database the auth
 * tables live in (`d1Executor(env.DB)`). Postgres and MySQL, which `ensureMigrated` backfills through
 * better-auth's adapter, are not covered, and the auth Durable Object keeps its tables in its own
 * storage, which no executor reaches.
 *
 * ```ts
 * const status = await authBackfillStatus(d1Executor(env.DB), authOptions);
 * if (status.canonicalEmail?.duplicates.length) {
 *     // merge or rename each `id`; `heldBy` is the account that keeps the address
 * }
 * ```
 */
const authBackfillStatus = async (executor: BackfillExecutor, options: LunoraAuthOptions): Promise<AuthBackfillStatus> => {
    const resolved = resolveAuthOptions(options);
    const column = authCanonicalEmailColumn(resolved);
    const invitations = invitationEmailColumns(resolved);
    const status: AuthBackfillStatus = {};

    if (column !== undefined) {
        const table = quote(column.table);
        const canonical = quote(column.canonical);
        const [counted] = await executor.all(`SELECT count(*) AS "unfilled" FROM ${table} WHERE ${canonical} IS NULL`, []);
        const unfilled = Number(counted?.["unfilled"] ?? 0);
        const rows = await executor.all(`SELECT "id", ${quote(column.email)} AS "email" FROM ${table} WHERE ${canonical} IS NULL ORDER BY rowid LIMIT ?`, [
            MAX_REPORTED_DUPLICATES,
        ]);
        const unfilledRows = rows
            .filter((row) => typeof row["email"] === "string")
            .map((row) => {
                return { canonical: canonicalEmail(row["email"] as string), id: String(row["id"]) };
            });
        const holders =
            unfilledRows.length > 0
                ? await executor.all(`SELECT "id", ${canonical} FROM ${table} WHERE ${canonical} IN (SELECT "value" FROM json_each(?))`, [
                      JSON.stringify([...new Set(unfilledRows.map((row) => row.canonical))]),
                  ])
                : [];

        status.canonicalEmail = {
            duplicates: duplicateRows(unfilledRows, holders, column.canonical).filter((row) => row.heldBy !== undefined),
            inProgress: await hasSavedPosition(executor, `${column.table}.${column.canonical}`),
            truncated: unfilled > rows.length,
            unfilled,
        };
    }

    if (invitations !== undefined) {
        status.invitationEmail = { inProgress: await hasSavedPosition(executor, `${invitations.table}.${invitations.email}`) };
    }

    return status;
};

export type { AuthBackfillStatus, CanonicalEmailBackfillStatus };
export { authBackfillStatus };
