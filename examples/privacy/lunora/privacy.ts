/**
 * The app's privacy configuration. The settings are fixed; the ports are bound per call
 * from the caller's context, because `ctx.db` exists only inside one.
 *
 *   await privacyFor(ctx).requestExport({ subjectId });
 */
import { defineDataset, definePrivacy } from "@lunora/privacy";
import { germany } from "@lunora/privacy/de";
import { eu } from "@lunora/privacy/eu";
import type { WorkflowRunContext } from "@lunora/workflow";

import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { localPorts, remotePorts } from "./privacy-ports";

/** The tasks a user keeps. Every row is theirs, so the export and erasure cover the whole table. */
export const tasksData = defineDataset("tasks", {
    legalBasis: "contract",
    origin: "provided",
    purpose: "Tasks the user keeps in the list",
    tables: { tasks: {} },
});

/** A query's or a mutation's context, or a workflow step's context, which reaches the database through `ctx.run`. */
export type PrivacyContext = MutationCtx | QueryCtx | WorkflowRunContext<{ requestId: string }>;

export const privacyFor = definePrivacy<PrivacyContext>({
    datasets: [tasksData],
    presets: [eu(), germany()],
    ports: (context) => ("db" in context ? localPorts(context) : remotePorts(context.run)),
});

/**
 * The durable handlers. Each one binds the ports from its own context, so the step
 * functions run against the database through `ctx.run`.
 */
export const privacyWorkflows = {
    erasureHandler: async (context: WorkflowRunContext<{ requestId: string }>): Promise<void> => privacyFor(context).workflows.erasureHandler(context),
    exportHandler: async (context: WorkflowRunContext<{ requestId: string }>): Promise<void> => privacyFor(context).workflows.exportHandler(context),
};
