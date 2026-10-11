/**
 * The functions a client calls, and the internal ones the cron and the workflows call.
 * The package supplies the logic; these wrappers choose the subject from the caller's
 * session, so a caller cannot open a request for someone else.
 */
import type { RequestRecord } from "@lunora/privacy";
import { LunoraError } from "lunorash/errors";
import { rateLimit } from "lunorash/ratelimit";
import { v } from "lunorash/values";

import type { Doc as Document_ } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { internalMutation, mutation, query } from "./_generated/server.js";
import { byCaller, limiter } from "./limits";
import { privacyFor } from "./privacy";
import { dispatchPort } from "./privacy-ports";
import { sessionAgeMs, subjectOf } from "./subject";

/** A request as the caller's own list shows it. Dates are epoch milliseconds. */
export interface RequestSummary {
    dueAt: number;
    expiresAt: number | undefined;
    id: string;
    receivedAt: number;
    status: Document_<"privacy_requests">["status"];
    type: Document_<"privacy_requests">["type"];
}

const millis = (date: Date | undefined): number | undefined => date?.getTime();

/** What a client sees of a request it has just opened. */
const view = (request: RequestRecord): RequestSummary => {
    return {
        dueAt: millis(request.dueAt) ?? 0,
        expiresAt: millis(request.expiresAt),
        id: request.id,
        receivedAt: millis(request.receivedAt) ?? 0,
        status: request.status,
        type: request.type,
    };
};

/** Fails unless the request exists and belongs to the caller. The same answer for both, so ids cannot be probed. */
const requireOwnRequest = async (ctx: MutationCtx, requestId: string): Promise<void> => {
    const row = await ctx.db
        .query("privacy_requests")
        .withIndex("byRequestId", (q) => q.eq("requestId", requestId))
        .first();

    if (row?.subjectId !== subjectOf(ctx)) {
        throw new LunoraError("NOT_FOUND", `No privacy request with id ${requestId}.`);
    }
};

export const requestExport = mutation.use(rateLimit(limiter, "write", byCaller)).mutation(async ({ ctx }): Promise<RequestSummary> => {
    const request = await privacyFor(ctx).requestExport({ subjectId: subjectOf(ctx) });

    await ctx.workflows.get("privacyExport").create({ id: request.id, params: { requestId: request.id } });
    ctx.log.info("privacy export requested", { requestId: request.id });

    return view(request);
});

export const requestErasure = mutation.use(rateLimit(limiter, "write", byCaller)).mutation(async ({ ctx }): Promise<RequestSummary> => {
    const request = await privacyFor(ctx).requestErasure({ sessionAgeMs: await sessionAgeMs(ctx), subjectId: subjectOf(ctx) });

    await ctx.workflows.get("privacyErasure").create({ id: request.id, params: { requestId: request.id } });
    ctx.log.info("privacy erasure requested", { requestId: request.id });

    return view(request);
});

export const cancelRequest = mutation
    .use(rateLimit(limiter, "write", byCaller))
    .input({ requestId: v.string().max(64) })
    .mutation(async ({ args: { requestId }, ctx }): Promise<RequestSummary> => {
        await requireOwnRequest(ctx, requestId);

        const request = await privacyFor(ctx).cancelRequest({ requestId });

        ctx.log.info("privacy request cancelled", { requestId });

        return view(request);
    });

/** The caller's own requests, newest first. */
export const myRequests = query.query(async ({ ctx }): Promise<RequestSummary[]> => {
    const rows = await ctx.db
        .query("privacy_requests")
        .withIndex("bySubject", (q) => q.eq("subjectId", subjectOf(ctx)))
        .collect();

    return rows
        .toSorted((a, b) => b.receivedAt - a.receivedAt)
        .map((row) => {
            return {
                dueAt: row.dueAt,
                expiresAt: row.expiresAt,
                id: row.requestId,
                receivedAt: row.receivedAt,
                status: row.status,
                type: row.type,
            };
        });
});

/** A link to a finished export. Refused for anyone but the subject, and once the export has expired. */
export const downloadUrl = query
    .input({ requestId: v.string().max(64) })
    .query(async ({ args: { requestId }, ctx }) => privacyFor(ctx).downloadUrl({ requestId, subjectId: subjectOf(ctx) }));

/** The daily deadline sweep. Internal: only the cron calls it. */
export const privacyTick = internalMutation.mutation(async ({ ctx }) => {
    const { approaching, overdue } = await privacyFor(ctx).tick();

    ctx.log.info("privacy deadlines checked", { approaching: approaching.length, overdue: overdue.length });

    return { approaching: approaching.map((request) => request.id), overdue: overdue.map((request) => request.id) };
});

/** The port the durable workflows call through `ctx.run`. Internal: never reachable from a client. */
export const privacyPort = internalMutation
    .input({ method: v.string(), payload: v.string() })
    .mutation(async ({ args: { method, payload }, ctx }) => dispatchPort(ctx, method, payload));
