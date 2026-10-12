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
 * Run after a point-in-time restore of the shard (`lunora backup pitr --restore`). The restored shard
 * can hold rows of subjects who were erased after the backup was taken. This starts the restore
 * workflow with every subject id the restored `tasks` table holds; the workflow reads the tombstone
 * store, which the restore did not roll back, and erases those subjects again.
 *
 * Internal, like the other operator functions: only the admin plane and server code can call it. It
 * reads the whole `tasks` table once, which an operator does once per restore.
 */
export const restorePrivacyErasures = internalAction.action(async ({ ctx }) => {
    const rows = await ctx.db.query("tasks").collect();
    const restoredSubjectIds = [...new Set(rows.map((row) => row.userId))];
    const id = `privacy-restore-${String(ctx.now)}`;

    try {
        await ctx.workflows.get("privacyRestore").create({ id, params: { restoredSubjectIds } });
    } catch (error: unknown) {
        throw new LunoraError("INTERNAL", `The privacy-restore workflow could not be started: ${error instanceof Error ? error.message : String(error)}`);
    }

    ctx.log.info("privacy restore started", { id, subjects: restoredSubjectIds.length });

    return { id, subjects: restoredSubjectIds.length };
});
