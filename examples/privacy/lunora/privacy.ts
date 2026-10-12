/**
 * The app's privacy configuration, defined once. The ports are bound per call from the
 * caller's context, because `ctx.db` exists only inside one; a subject's call also passes
 * the identity its handler resolved from the session.
 *
 *   await privacyFor(ctx, await identityOf(ctx)).requestExport();
 */
import { defineDataset, definePrivacy } from "@lunora/privacy";
import { remotePorts } from "@lunora/privacy/workflow";
import type { WorkflowRunContext } from "@lunora/workflow";

import { internal } from "./_generated/internal.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { localPorts } from "./privacy-ports";
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
 * What the workflow's port dispatcher reads (`dispatchPort` in `requests.ts`): the same datasets
 * and presets `definePrivacy` reads, so both sides look a dataset up and judge a row the same way.
 */
export const privacyConfig = {
    datasets: [tasksData],
    presets,
};

/**
 * The HMAC secret that keys the erasure tombstones. Set `PRIVACY_TOMBSTONE_SECRET` as a Worker
 * secret (`wrangler secret put`) or in `.dev.vars`. With it unset, an erasure fails with a clear
 * message rather than writing unkeyed tombstones.
 */
const tombstoneSecret = process.env.PRIVACY_TOMBSTONE_SECRET;

/** A workflow step's ports: the shard through `ctx.run`, and the tombstones, which live outside it, through `ctx.env`. */
const workflowPorts = (context: WorkflowRunContext<{ requestId: string }>) => {
    return {
        ...remotePorts(async (call) => context.run(internal.requests.privacyPort, call)),
        tombstones: tombstonesFrom(context.env),
    };
};

export const privacyFor = definePrivacy<PrivacyContext>({
    ...privacyConfig,
    ports: (context) => ("db" in context ? localPorts(context) : workflowPorts(context)),
    tombstoneSecret,
});

/**
 * The durable handlers. Each one binds the ports from its own context, so the step
 * functions run against the database through `ctx.run`.
 */
export const privacyWorkflows = {
    erasureHandler: async (context: WorkflowRunContext<{ requestId: string }>): Promise<void> => privacyFor(context).workflows.erasureHandler(context),
    exportHandler: async (context: WorkflowRunContext<{ requestId: string }>): Promise<void> => privacyFor(context).workflows.exportHandler(context),
};
