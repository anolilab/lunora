/**
 * The operator's functions, for the Studio's Privacy requests page. Both are internal:
 * a client cannot call them, only the admin plane and server code. They are the two
 * functions a `PrivacyRequestsSource` reads and writes.
 *
 * There is no function to extend a request's deadline. An extension is an operator's
 * decision with a written reason, not something a subject or a client asks for.
 */
import type { RequestRecord } from "@lunora/privacy";
import { LunoraError } from "lunorash/errors";
import { v } from "lunorash/values";

import { internalMutation, internalQuery } from "./_generated/server.js";
import { privacyFor } from "./privacy";

/** One open request as the Studio's page shows it. Dates are epoch milliseconds. */
export interface OpenRequestRow {
    extendedDueAt: number | null;
    id: string;
    receivedAt: number;
    status: RequestRecord["status"];
    subjectId: string;
    type: RequestRecord["type"];
}

const rowOf = (record: RequestRecord): OpenRequestRow => {
    return {
        extendedDueAt: record.extendedDueAt?.getTime() ?? null,
        id: record.id,
        receivedAt: record.receivedAt.getTime(),
        status: record.status,
        subjectId: record.subjectId,
        type: record.type,
    };
};

/** Every request that is not yet terminal: the package's `admin.open()`. */
export const listOpenPrivacyRequests = internalQuery.query(async ({ ctx }): Promise<OpenRequestRow[]> => {
    const open = await privacyFor(ctx).admin.open();

    return open.map((record) => rowOf(record));
});

/**
 * Re-run a failed request. An export re-runs here through the package's `admin.retry`. An
 * erasure restarts its workflow instead: only the workflow reaches the tombstone store,
 * and a failed erasure skips the grace and resumes from its `failed` status.
 */
export const retryPrivacyRequest = internalMutation.input({ requestId: v.string().max(64) }).mutation(async ({ args: { requestId }, ctx }) => {
    const privacy = privacyFor(ctx);
    const open = await privacy.admin.open();
    const record = open.find((candidate) => candidate.id === requestId);

    if (record?.status !== "failed") {
        throw new LunoraError("UNPROCESSABLE", `Only a failed request can be retried; ${requestId} is not one.`);
    }

    if (record.type === "erasure") {
        await ctx.workflows.get("privacyErasure").create({ id: `${requestId}-retry-${String(ctx.now)}`, params: { requestId } });
        ctx.log.info("privacy erasure retry started", { requestId });

        return { requestId, status: "restarted" as const };
    }

    const outcome = await privacy.admin.retry(requestId);

    ctx.log.info("privacy export retried", { requestId, status: outcome.status });

    return { requestId, status: outcome.status };
});
