/**
 * `signUpInvitation.email` rewritten to {@link canonicalEmail}, for invitations issued while
 * the address was stored trimmed and lowercased only. Every lookup now matches on the
 * canonical form, so an invitation for an address typed in decomposed Unicode would
 * otherwise never be found again, by the invitee, a re-invite or a revoke.
 */
import type { BetterAuthOptions } from "better-auth";
import { getAuthTables } from "better-auth/db";

import type { BackfillExecutor, BackfillSteps } from "./canonical-email";
import { BACKFILL_PAGE_ROWS, canonicalEmail, quote, readBackfillState, runBackfill, runBackfillSync, writeBackfillState } from "./canonical-email";
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

/** The rewrite's three statements over the physical names. */
const invitationStatements = (columns: InvitationEmailColumns): { holders: string; read: (after: boolean) => string; update: string } => {
    const table = quote(columns.table);
    const email = quote(columns.email);
    const createdAt = quote(columns.createdAt);

    return {
        holders: `SELECT ${email} AS "email" FROM ${table} WHERE ${email} IN (SELECT "value" FROM json_each(?))`,
        read: (after) =>
            `SELECT rowid AS "rid", "id", ${email} AS "email", ${createdAt} AS "createdAt" FROM ${table} ` +
            `WHERE (${email} GLOB '*[^ -~]*' OR ${email} <> LOWER(TRIM(${email})))${after ? ` AND (${createdAt}, rowid) < (?, ?)` : ""} ` +
            `ORDER BY ${createdAt} DESC, rowid DESC LIMIT ?`,
        // Guarded like the user backfill: only while the row still holds the address read, and nothing took the new one.
        update:
            `UPDATE ${table} SET ${email} = "v"."folded" ` +
            `FROM (SELECT json_extract("value", '$[0]') AS "rid", json_extract("value", '$[1]') AS "email", json_extract("value", '$[2]') AS "folded" FROM json_each(?)) AS "v" ` +
            `WHERE ${table}.rowid = "v"."rid" AND ${table}.${email} = "v"."email" ` +
            `AND NOT EXISTS (SELECT 1 FROM ${table} AS "held" WHERE "held".${email} = "v"."folded") RETURNING rowid`,
    };
};

/**
 * A page's rows to rewrite, by folded address: the newest of each, unless a newer one read
 * earlier already holds it. The others go to `unchanged`; an address already in canonical
 * form joins `settled` like a rewritten one.
 */
const pageCandidates = (rows: Record<string, unknown>[], settled: Set<string>, unchanged: string[]): Map<string, Record<string, unknown>> => {
    const candidates = new Map<string, Record<string, unknown>>();

    for (const row of rows) {
        const { email } = row;

        if (typeof email !== "string") {
            continue;
        }

        const folded = canonicalEmail(email);

        if (folded === email) {
            settled.add(folded);
        } else if (settled.has(folded) || candidates.has(folded)) {
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

    if (candidates.size > 0) {
        yield { params: [JSON.stringify([...candidates].map(([folded, row]) => [row["rid"], row["email"], folded]))], sql: sql.update };
    }
};

/**
 * Recorded once a pass has read every invitation and left none for a collision: new ones are
 * written in canonical form, so none can need it again.
 */
const DONE = "done";

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
 * That read keeps matching a non-ASCII address once it is canonical, and an invitation left
 * unchanged, so each page records where it stopped and a run cut short resumes there, and a
 * whole pass that reaches the end leaving nothing unchanged records that it is done. Without
 * either, every run would re-read the same newest rows. A resumed run finds a holder on the table, not in the cut-short
 * run's memory, so resuming loses nothing.
 * @returns The ids of the invitations left unchanged because another holds their folded address.
 */
const invitationBackfillSteps = function* invitationBackfillSteps(columns: InvitationEmailColumns): BackfillSteps<string[]> {
    const sql = invitationStatements(columns);
    const settled = new Set<string>();
    const unchanged: string[] = [];
    // Keyed on the physical names, like the user backfill's.
    const state = `${columns.table}.${columns.email}`;
    const resumed = yield* readBackfillState(state);

    if (resumed === DONE) {
        return unchanged;
    }

    let cursor: unknown[] = Array.isArray(resumed) ? resumed : [];

    for (;;) {
        const rows = yield { params: [...cursor, BACKFILL_PAGE_ROWS], sql: sql.read(cursor.length > 0) };

        const candidates = pageCandidates(rows, settled, unchanged);

        yield* rewritePage(sql, candidates, unchanged);

        for (const folded of candidates.keys()) {
            settled.add(folded);
        }

        const last = rows.at(-1);

        if (rows.length < BACKFILL_PAGE_ROWS || last === undefined) {
            // An invitation left for a collision is rewritten once its holder is revoked, so the next pass (a later cold
            // start) starts over; so does one after a resumed run, which cannot see what the cut-short run left.
            yield* writeBackfillState(state, unchanged.length === 0 && !Array.isArray(resumed) ? DONE : undefined);

            return unchanged;
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
                `are ignored, so they were left unchanged and cannot be matched: ${unchanged.join(", ")}. Revoke or re-issue them.`,
        );
    }
};

/**
 * Rewrite invitation addresses to canonical form through an async executor (D1), to the end
 * of the table, resuming where a run cut short stopped.
 * @returns The ids of the invitations left unchanged because another holds their folded address.
 */
const backfillInvitationEmails = async (executor: BackfillExecutor, columns: InvitationEmailColumns): Promise<string[]> => {
    const unchanged = await runBackfill(invitationBackfillSteps(columns), executor);

    warnUnchanged(unchanged);

    return unchanged;
};

/**
 * The same rewrite over a synchronous executor (a Durable Object's `storage.sql.exec`).
 * @returns The ids of the invitations left unchanged because another holds their folded address.
 */
const backfillInvitationEmailsSync = (exec: (sql: string, params: unknown[]) => Record<string, unknown>[], columns: InvitationEmailColumns): string[] => {
    const unchanged = runBackfillSync(invitationBackfillSteps(columns), exec);

    warnUnchanged(unchanged);

    return unchanged;
};

export type { InvitationEmailColumns };
export { backfillInvitationEmails, backfillInvitationEmailsSync, invitationEmailColumns };
