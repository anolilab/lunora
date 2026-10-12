/**
 * The app's privacy configuration. The settings are fixed; the ports are bound per call
 * from the caller's context, because `ctx.db` exists only inside one.
 *
 *   await privacyFor(ctx).requestExport({ subjectId });
 */
import { defineDataset, definePrivacy } from "@lunora/privacy";
import type { WorkflowRunContext } from "@lunora/workflow";

import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import type { CallIdentity } from "./privacy-ports";
import { localPorts, remotePorts } from "./privacy-ports";
import { presets } from "./privacy-presets";
import { tombstonesFrom } from "./privacy-tombstones";

/** The tasks a user keeps. Every row is theirs, so the export and erasure cover the whole table. */
export const tasksData = defineDataset("tasks", {
    legalBasis: "contract",
    origin: "provided",
    purpose: "Tasks the user keeps in the list",
    tables: { tasks: {} },
});

/** A query's or a mutation's context, or a workflow step's context, which reaches the database through `ctx.run`. */
export type PrivacyContext = MutationCtx | QueryCtx | WorkflowRunContext<{ requestId: string }>;

/**
 * The HMAC secret that keys the erasure tombstones. Set `PRIVACY_TOMBSTONE_SECRET` as a Worker
 * secret (`wrangler secret put`) or in `.dev.vars`. With it unset, an erasure fails with a clear
 * message rather than writing unkeyed tombstones.
 */
const tombstoneSecret = process.env.PRIVACY_TOMBSTONE_SECRET;

export const privacyFor = definePrivacy<PrivacyContext>({
    datasets: [tasksData],
    presets,
    tombstoneSecret,
    // A workflow step reaches the shard through `ctx.run`, and the tombstones, which live outside it, through `ctx.env`.
    ports: (context) => ("db" in context ? localPorts(context) : { ...remotePorts(context.run), tombstones: tombstonesFrom(context.env) }),
});

/**
 * The privacy API bound to a subject's own call. The handler resolves `identity` from
 * its session first, so the subject methods can only act for that caller.
 */
export const privacyAs = (ctx: MutationCtx | QueryCtx, identity: CallIdentity): ReturnType<typeof privacyFor> =>
    definePrivacy<MutationCtx | QueryCtx>({
        datasets: [tasksData],
        presets,
        tombstoneSecret,
        ports: () => localPorts(ctx, identity),
    })(ctx);

/**
 * The durable handlers. Each one binds the ports from its own context, so the step
 * functions run against the database through `ctx.run`.
 */
export const privacyWorkflows = {
    erasureHandler: async (context: WorkflowRunContext<{ requestId: string }>): Promise<void> => privacyFor(context).workflows.erasureHandler(context),
    exportHandler: async (context: WorkflowRunContext<{ requestId: string }>): Promise<void> => privacyFor(context).workflows.exportHandler(context),
};
