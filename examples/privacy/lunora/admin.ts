/**
 * The operator's functions. All are internal: a client cannot call them, only the admin
 * plane and server code. The first two are what the Studio's Privacy requests page reads
 * and writes through a `PrivacyRequestsSource`; the last re-erases after a restore.
 *
 * There is no function to extend a request's deadline. An extension is an operator's
 * decision with a written reason, not something a subject or a client asks for.
 */
import type { RequestRecord } from "@lunora/privacy";
import { LunoraError } from "lunorash/errors";
import { v } from "lunorash/values";

import type { PrivacyRequestRow } from "../../../shared/privacy-request-row";
import type { QueryCtx } from "./_generated/server.js";
import { internalAction, internalMutation, internalQuery } from "./_generated/server.js";
import { privacyFor } from "./privacy";

/** One open request in the row shape the Studio's page reads (`shared/privacy-request-row`). */
const rowOf = (record: RequestRecord): PrivacyRequestRow => {
    return {
        dueAt: record.dueAt.getTime(),
        extendedDueAt: record.extendedDueAt?.getTime() ?? null,
        id: record.id,
        receivedAt: record.receivedAt.getTime(),
        status: record.status,
        subjectId: record.subjectId,
        type: record.type,
    };
};

/** Every request that is not yet terminal: the package's `admin.open()`. */
export const listOpenPrivacyRequests = internalQuery.query(async ({ ctx }): Promise<PrivacyRequestRow[]> => {
    const open = await privacyFor(ctx).admin.open();

    return open.map((record) => rowOf(record));
});

/**
 * Re-run a failed request through the package's `admin.retry`, which refuses one that has not failed.
 * An export re-runs inline. An erasure comes back as `restart`: the package has already moved it out
 * of `failed`, so a second retry is refused, and only the workflow reaches the tombstone store, so
 * this starts it again. The workflow resumes from the status the package set.
 */
export const retryPrivacyRequest = internalMutation.input({ requestId: v.string().max(64) }).mutation(async ({ args: { requestId }, ctx }) => {
    const result = await privacyFor(ctx).admin.retry(requestId);

    if (result.kind === "restart") {
        await ctx.workflows.get("privacyErasure").create({ id: `${result.requestId}-retry-${String(ctx.now)}`, params: { requestId: result.requestId } });
        ctx.log.info("privacy erasure retry started", { requestId });

        return { requestId, status: "restarted" as const };
    }

    ctx.log.info("privacy export retried", { requestId, status: result.outcome.status });

    return { requestId, status: result.outcome.status };
});

/**
 * Every subject id the shard's personal-data tables hold: who a restore may have brought back. A subject
 * whose invoices were all erased into the retention archive has no live invoice row, so the archive is read too.
 */
export const restoredSubjectIdsOf = async (ctx: { readonly db: { readonly query: QueryCtx["db"]["query"] } }): Promise<string[]> => {
    const [tasks, invoices, archived] = await Promise.all([
        ctx.db.query("tasks").collect(),
        ctx.db.query("invoices").collect(),
        ctx.db.query("privacy_archive").collect(),
    ]);

    return [...new Set([...tasks.map((row) => row.userId), ...invoices.map((row) => row.userId), ...archived.map((row) => row.subjectId)])];
};

/**
 * Run after a point-in-time restore of the shard (`lunora backup pitr --restore`). The restored shard
 * can hold rows of subjects who were erased after the backup was taken. This starts the restore
 * workflow with every subject id the restored `tasks` and `invoices` tables hold, so a subject with
 * only invoices is covered too. The workflow reads the tombstone store, which the restore did not roll
 * back, and erases those subjects again.
 *
 * Internal, like the other operator functions: only the admin plane and server code can call it. It
 * reads the whole of both tables once, which an operator does once per restore.
 */
export const restorePrivacyErasures = internalAction.action(async ({ ctx }) => {
    const restoredSubjectIds = await restoredSubjectIdsOf(ctx);
    const id = `privacy-restore-${String(ctx.now)}`;

    try {
        await ctx.workflows.get("privacyRestore").create({ id, params: { restoredSubjectIds } });
    } catch (error: unknown) {
        throw new LunoraError("INTERNAL", `The privacy-restore workflow could not be started: ${error instanceof Error ? error.message : String(error)}`);
    }

    ctx.log.info("privacy restore started", { id, subjects: restoredSubjectIds.length });

    return { id, subjects: restoredSubjectIds.length };
});
