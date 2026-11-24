/**
 * `signUpInvitation.email` rewritten to {@link canonicalEmail}, for invitations issued while
 * the address was stored trimmed and lowercased only. Every lookup now matches on the
 * canonical form, so an invitation for an address typed in decomposed Unicode would
 * otherwise never be found again, by the invitee, a re-invite or a revoke.
 */
import type { BetterAuthOptions } from "better-auth";
import { getAuthTables } from "better-auth/db";

import type { BackfillAdapter, BackfillExecutor, BackfillSteps } from "./canonical-email";
import {
    aliasBeside,
    BACKFILL_MAX_PAGES,
    BACKFILL_MAX_PAGES_SYNC,
    BACKFILL_PAGE_ROWS,
    canonicalEmail,
    quote,
    readBackfillState,
    runBackfill,
    runBackfillSync,
    writeBackfillState,
} from "./canonical-email";
import { INVITATION_MODEL } from "./invite-only";

/** The physical names the rewrite reads; `undefined` from {@link invitationEmailColumns} without `inviteOnly()`. */
interface InvitationEmailColumns {
    createdAt: string;
    email: string;
    table: string;
}

/**
 * The physical names for {@link InvitationEmailColumns}, read off better-auth's resolved tables.
 * @param options Resolved auth options — ones that went through `resolveAuthOptions`.
 */
const invitationEmailColumns = (options: BetterAuthOptions): InvitationEmailColumns | undefined => {
    const table = getAuthTables(options)[INVITATION_MODEL];

    if (table === undefined) {
        return undefined;
    }

    return {
        createdAt: table.fields["createdAt"]?.fieldName ?? "createdAt",
        email: table.fields["email"]?.fieldName ?? "email",
        table: table.modelName,
    };
};

/** The rewrite's statements over the physical names. */
const invitationStatements = (columns: InvitationEmailColumns): { holders: string; read: (after: boolean) => string; rows: string; update: string } => {
    const table = quote(columns.table);
    const email = quote(columns.email);
    const createdAt = quote(columns.createdAt);
    const values = aliasBeside(columns.table, "v");
    const held = aliasBeside(columns.table, "held");

    return {
        holders: `SELECT ${email} AS "email" FROM ${table} WHERE ${email} IN (SELECT "value" FROM json_each(?))`,
        read: (after) =>
            `SELECT rowid AS "rid", "id", ${email} AS "email", ${createdAt} AS "createdAt" FROM ${table} ` +
            `WHERE (${email} GLOB '*[^ -~]*' OR ${email} <> LOWER(TRIM(${email})))${after ? ` AND (${createdAt}, rowid) < (?, ?)` : ""} ` +
            `ORDER BY ${createdAt} DESC, rowid DESC LIMIT ?`,
        rows: `SELECT rowid AS "rid", ${email} AS "email" FROM ${table} WHERE rowid IN (SELECT "value" FROM json_each(?))`,
        // Guarded like the user backfill: only while the row still holds the address read, and nothing took the new one.
        update:
            `UPDATE ${table} SET ${email} = ${values}."folded" ` +
            `FROM (SELECT json_extract("value", '$[0]') AS "rid", json_extract("value", '$[1]') AS "email", json_extract("value", '$[2]') AS "folded" FROM json_each(?)) AS ${values} ` +
            `WHERE ${table}.rowid = ${values}."rid" AND ${table}.${email} = ${values}."email" ` +
            `AND NOT EXISTS (SELECT 1 FROM ${table} AS ${held} WHERE ${held}.${email} = ${values}."folded") RETURNING rowid AS "rid"`,
    };
};

/**
 * A page's rows to rewrite, by folded address: the newest of each on the page; the others go
 * to `unchanged`. A row that holds its address from an earlier page, or already in canonical
 * form, is found by `rewritePage`'s read of the table, so nothing is kept across pages.
 */
const pageCandidates = (rows: Record<string, unknown>[], unchanged: string[]): Map<string, Record<string, unknown>> => {
    const candidates = new Map<string, Record<string, unknown>>();

    for (const row of rows) {
        const { email } = row;

        if (typeof email !== "string") {
            continue;
        }

        const folded = canonicalEmail(email);

        if (folded === email) {
            continue;
        }

        if (candidates.has(folded)) {
            unchanged.push(String(row["id"]));
        } else {
            candidates.set(folded, row);
        }
    }

    return candidates;
};

/** Rewrite `candidates`, leaving (and reporting) any whose folded address an older row already holds. */
const rewritePage = function* rewritePage(
    sql: ReturnType<typeof invitationStatements>,
    candidates: Map<string, Record<string, unknown>>,
    unchanged: string[],
): BackfillSteps<void> {
    if (candidates.size === 0) {
        return;
    }

    const holders = yield { params: [JSON.stringify([...candidates.keys()])], sql: sql.holders };

    for (const holder of holders) {
        const folded = String(holder["email"]);

        unchanged.push(String(candidates.get(folded)?.["id"]));
        candidates.delete(folded);
    }

    if (candidates.size === 0) {
        return;
    }

    const written = yield { params: [JSON.stringify([...candidates].map(([folded, row]) => [row["rid"], row["email"], folded]))], sql: sql.update };
    const rewritten = new Set(written.map((row) => row["rid"]));
    const skipped = [...candidates.values()].filter((row) => !rewritten.has(row["rid"]));

    if (skipped.length === 0) {
        return;
    }

    // An issuer took the address after the holder read. A row changed or removed meanwhile is not a collision.
    const current = yield { params: [JSON.stringify(skipped.map((row) => row["rid"]))], sql: sql.rows };
    const unmoved = new Set(current.map((row) => `${String(row["rid"])}\u0000${String(row["email"])}`));

    for (const row of skipped) {
        if (unmoved.has(`${String(row["rid"])}\u0000${String(row["email"])}`)) {
            unchanged.push(String(row["id"]));
        }
    }
};

/** What one run did, filled in as it goes like the user backfill's report. */
interface InvitationBackfillReport {
    complete: boolean;
    /** The ids of the invitations left unchanged because another holds their folded address. */
    unchanged: string[];
}

/**
 * The rewrite as a sequence of statements, run like the user backfill.
 *
 * SQLite cannot tell whether an address is in canonical form, so the read narrows to the rows
 * that can be out of it: non-ASCII, or not trimmed and lowercased (`GLOB '*[^ -~]*'` is any
 * character outside printable ASCII). Newest first, so the first invitation met for a folded
 * address is the one that keeps it, and an older one folding to it stays as it is and is
 * reported, never deleted. One that already holds the canonical form is a holder like any
 * other: when it is the older of the two it keeps the address, because freeing it would mean
 * rewriting that row instead; the newer one is reported.
 *
 * At most `maxPages` pages a run. Each page records where it stopped, so the next run resumes
 * there; a resumed run finds a holder on the table, not in an earlier run's memory, so resuming
 * loses nothing. A pass that reaches the end clears that, so a later pass reads the table again:
 * an invitation left for a collision is rewritten once its holder is revoked, and one restored
 * from an older snapshot gets the canonical form. The read covers only rows that can be out of it.
 */
const invitationBackfillSteps = function* invitationBackfillSteps(
    columns: InvitationEmailColumns,
    maxPages: number,
    tally: { done: () => void; unchanged: string[] },
): BackfillSteps<void> {
    const sql = invitationStatements(columns);
    const { unchanged } = tally;
    // Keyed on the physical names, like the user backfill's.
    const state = `${columns.table}.${columns.email}`;
    const resumed = yield* readBackfillState(state);
    let cursor: unknown[] = Array.isArray(resumed) ? resumed : [];

    for (let page = 0; page < maxPages; page += 1) {
        const rows = yield { params: [...cursor, BACKFILL_PAGE_ROWS], sql: sql.read(cursor.length > 0) };

        yield* rewritePage(sql, pageCandidates(rows, unchanged), unchanged);

        const last = rows.at(-1);

        if (rows.length < BACKFILL_PAGE_ROWS || last === undefined) {
            if (cursor.length > 0) {
                yield* writeBackfillState(state, undefined);
            }

            tally.done();

            return;
        }

        cursor = [last["createdAt"], last["rid"]];
        yield* writeBackfillState(state, cursor);
    }
};

const warnUnchanged = (unchanged: string[]): void => {
    if (unchanged.length > 0) {
        // eslint-disable-next-line no-console -- no injected logger at the migration layer (workerd/Node both capture console)
        console.warn(
            `@lunora/auth: ${String(unchanged.length)} sign-up invitation(s) fold to an address another invitation holds once case and Unicode form ` +
                `are ignored, so they were left unchanged and cannot be matched: ${unchanged.join(", ")}. Delete those rows by id: revoking ` +
                `their address removes the invitation that holds it instead.`,
        );
    }
};

/**
 * Rewrite invitation addresses to canonical form through an async executor (D1), at most
 * `BACKFILL_MAX_PAGES` pages, resuming where the last run stopped.
 */
const backfillInvitationEmails = async (executor: BackfillExecutor, columns: InvitationEmailColumns): Promise<InvitationBackfillReport> => {
    const report: InvitationBackfillReport = { complete: false, unchanged: [] };
    const tally = { done: () => Object.assign(report, { complete: true }), unchanged: report.unchanged };

    try {
        await runBackfill(invitationBackfillSteps(columns, BACKFILL_MAX_PAGES, tally), executor);
    } finally {
        warnUnchanged(report.unchanged);
    }

    return report;
};

/** The same rewrite over a synchronous executor (a Durable Object's `storage.sql.exec`), at most `BACKFILL_MAX_PAGES_SYNC` pages. */
const backfillInvitationEmailsSync = (
    exec: (sql: string, params: unknown[]) => Record<string, unknown>[],
    columns: InvitationEmailColumns,
): InvitationBackfillReport => {
    const report: InvitationBackfillReport = { complete: false, unchanged: [] };
    const tally = { done: () => Object.assign(report, { complete: true }), unchanged: report.unchanged };

    try {
        runBackfillSync(invitationBackfillSteps(columns, BACKFILL_MAX_PAGES_SYNC, tally), exec);
    } finally {
        warnUnchanged(report.unchanged);
    }

    return report;
};

/**
 * The same rewrite through better-auth's adapter, for a database the SQL above cannot target.
 * The adapter cannot narrow the read to rows out of canonical form, so it pages every invitation,
 * newest first like the SQL, and writes only the ones that need it, one at a time: a holder must
 * see the rows already rewritten. Invitations expire and are few next to users, so a pass reads
 * the table to the end.
 */
const backfillInvitationEmailsThroughAdapter = async (adapter: BackfillAdapter): Promise<InvitationBackfillReport> => {
    const report: InvitationBackfillReport = { complete: false, unchanged: [] };

    try {
        for (let offset = 0; ; offset += BACKFILL_PAGE_ROWS) {
            // eslint-disable-next-line no-await-in-loop -- pages in order
            const rows = await adapter.findMany<{ email?: unknown; id: string }>({
                limit: BACKFILL_PAGE_ROWS,
                model: INVITATION_MODEL,
                offset,
                sortBy: { direction: "desc", field: "createdAt" },
            });

            for (const row of rows) {
                const folded = typeof row.email === "string" ? canonicalEmail(row.email) : undefined;

                if (folded === undefined || folded === row.email) {
                    continue;
                }

                // eslint-disable-next-line no-await-in-loop -- the check must see the rows this pass has already rewritten
                if ((await adapter.findOne({ model: INVITATION_MODEL, where: [{ field: "email", value: folded }] })) === null) {
                    // eslint-disable-next-line no-await-in-loop -- guarded like the SQL: only while the row still holds the address read
                    await adapter.update({
                        model: INVITATION_MODEL,
                        update: { email: folded },
                        where: [
                            { field: "id", value: row.id },
                            { field: "email", value: row.email as string },
                        ],
                    });
                } else {
                    report.unchanged.push(row.id);
                }
            }

            if (rows.length < BACKFILL_PAGE_ROWS) {
                report.complete = true;

                return report;
            }
        }
    } finally {
        warnUnchanged(report.unchanged);
    }
};

export type { InvitationBackfillReport, InvitationEmailColumns };
export { backfillInvitationEmails, backfillInvitationEmailsSync, backfillInvitationEmailsThroughAdapter, invitationEmailColumns };
