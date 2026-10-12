/**
 * The functions a client calls, and the internal ones the cron and the workflows call.
 * The package supplies the logic; these wrappers choose the subject from the caller's
 * session, so a caller cannot open a request for someone else.
 */
import type { RequestRecord, RequestStatus, RequestType } from "@lunora/privacy";
import { dispatchPort } from "@lunora/privacy/workflow";
import { rateLimit } from "lunorash/ratelimit";
import { v } from "lunorash/values";

import { internalMutation, mutation, query } from "./_generated/server.js";
import { byCaller, limiter } from "./limits";
import { privacyConfig, privacyFor } from "./privacy";
import { localPorts } from "./privacy-ports";
import { identityOf } from "./subject";

/**
 * A request as the caller's own list shows it. Dates are epoch milliseconds. It is narrower than the
 * operator's row (`shared/privacy-request-row`): a subject sees no subject id, and no storage key.
 */
export interface RequestSummary {
    dueAt: number;
    expiresAt: number | undefined;
    id: string;
    receivedAt: number;
    status: RequestStatus;
    type: RequestType;
}

/** What a client sees of a request. */
const view = (request: RequestRecord): RequestSummary => {
    return {
        dueAt: request.dueAt.getTime(),
        expiresAt: request.expiresAt?.getTime(),
        id: request.id,
        receivedAt: request.receivedAt.getTime(),
        status: request.status,
        type: request.type,
    };
};

export const requestExport = mutation.use(rateLimit(limiter, "write", byCaller)).mutation(async ({ ctx }): Promise<RequestSummary> => {
    const request = await privacyFor(ctx, await identityOf(ctx)).requestExport();

    await ctx.workflows.get("privacyExport").create({ id: request.id, params: { requestId: request.id } });
    ctx.log.info("privacy export requested", { requestId: request.id });

    return view(request);
});

export const requestErasure = mutation.use(rateLimit(limiter, "write", byCaller)).mutation(async ({ ctx }): Promise<RequestSummary> => {
    const request = await privacyFor(ctx, await identityOf(ctx)).requestErasure();

    await ctx.workflows.get("privacyErasure").create({ id: request.id, params: { requestId: request.id } });
    ctx.log.info("privacy erasure requested", { requestId: request.id });

    return view(request);
});

export const cancelRequest = mutation
    .use(rateLimit(limiter, "write", byCaller))
    .input({ requestId: v.string().max(64) })
    .mutation(async ({ args: { requestId }, ctx }): Promise<RequestSummary> => {
        // The package refuses a request that is not the caller's, with the same answer as a missing one.
        const request = await privacyFor(ctx, await identityOf(ctx)).cancelRequest({ requestId });

        ctx.log.info("privacy request cancelled", { requestId });

        return view(request);
    });

/** The caller's own requests in every status, newest first, as the package lists them. */
export const myRequests = query.query(async ({ ctx }): Promise<RequestSummary[]> => {
    const requests = await privacyFor(ctx, await identityOf(ctx)).myRequests();

    return requests.map((request) => view(request));
});

/** A link to a finished export. Refused for anyone but the subject, and once the export has expired. */
export const downloadUrl = query
    .input({ requestId: v.string().max(64) })
    .query(async ({ args: { requestId }, ctx }) => privacyFor(ctx, await identityOf(ctx)).downloadUrl({ requestId }));

/** The daily deadline sweep. Internal: only the cron calls it. */
export const privacyTick = internalMutation.mutation(async ({ ctx }) => {
    const { approaching, overdue } = await privacyFor(ctx).tick();

    ctx.log.info("privacy deadlines checked", { approaching: approaching.length, overdue: overdue.length });

    return { approaching: approaching.map((request) => request.id), overdue: overdue.map((request) => request.id) };
});

/**
 * The daily housekeeping sweep. Internal: only the cron calls it. It expires every ready export past
 * its download window, deleting its files first, and purges archived rows whose retention has ended.
 */
export const privacySweep = internalMutation.mutation(async ({ ctx }) => {
    const { expired, purged } = await privacyFor(ctx).admin.sweep();

    ctx.log.info("privacy housekeeping swept", { expired: expired.length, purged });

    return { expired: expired.map((request) => request.id), purged };
});

/** The port the durable workflows call through `ctx.run`. Internal: never reachable from a client. */
export const privacyPort = internalMutation
    .input({ method: v.string(), payload: v.string() })
    .mutation(async ({ args: { method, payload }, ctx }) => dispatchPort(privacyConfig, localPorts(ctx), method, payload));
