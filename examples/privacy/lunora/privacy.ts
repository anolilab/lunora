/**
 * The app's privacy configuration, defined once. The ports are bound per call from the
 * caller's context, because `ctx.db` exists only inside one; a subject's call also passes
 * the identity its handler resolved from the session.
 *
 *   await privacyFor(ctx, await identityOf(ctx)).requestExport();
 */
import type { PrivacyConfig } from "@lunora/privacy";
import { authDataset, defineDataset, definePrivacy, retain } from "@lunora/privacy";
import { remotePorts } from "@lunora/privacy/workflow";
import type { WorkflowRunContext } from "@lunora/workflow";

import { internal } from "./_generated/internal.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { authDatabaseFrom, withAuthTables } from "./privacy-auth";
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

/**
 * The invoices a user was billed. The German voucher rule keeps each one for its statutory period, so
 * erasure archives the row rather than deleting it, and the sweep purges it once that period has ended.
 */
export const billingData = defineDataset("billing", {
    legalBasis: "legal_obligation",
    origin: "provided",
    purpose: "Invoices issued to the user, kept for the tax retention period",
    tables: { invoices: { erase: retain("de.voucher", { from: "issuedAt" }) } },
});

/**
 * better-auth's sign-in tables: the user, session and account rows. They live in D1, so only the workflow
 * reaches them (see `privacy-auth.ts`).
 */
export const authData = authDataset();

/**
 * better-auth's verification table: identifiers and tokens for email verification, password reset and sign-in
 * codes. A row matches a subject by the address it was issued to or by the user id it carries (see `privacy-auth.ts`),
 * so this dataset is served from D1 as well.
 */
export const signInTokens = defineDataset("signInTokens", {
    legalBasis: "contract",
    origin: "provided",
    purpose: "Verification codes and tokens issued to the user for sign-in and account recovery",
    tables: { verification: {} },
});

/** The params of the restore workflow: the subject ids the restored shard holds. */
export interface RestoreParameters {
    restoredSubjectIds: string[];
}

/** A request's workflow, or the restore workflow. Both reach the database through `ctx.run`. */
type PrivacyWorkflowRun = WorkflowRunContext<RestoreParameters> | WorkflowRunContext<{ requestId: string }>;

/** A query's or a mutation's context, or a workflow's. */
export type PrivacyContext = MutationCtx | PrivacyWorkflowRun | QueryCtx;

/**
 * The HMAC secret that keys the erasure tombstones. Set `PRIVACY_TOMBSTONE_SECRET` as a Worker
 * secret (`wrangler secret put`) or in `.dev.vars`. With it unset, an erasure fails with a clear
 * message rather than writing unkeyed tombstones.
 */
const tombstoneSecret = process.env.PRIVACY_TOMBSTONE_SECRET;

/** A workflow step's ports: the shard through `ctx.run`, and the tombstones, which live outside it, through `ctx.env`. */
const workflowPorts = (context: PrivacyWorkflowRun) => {
    const remote = remotePorts(async (call) => context.run(internal.requests.privacyPort, call));

    return {
        ...remote,
        data: withAuthTables(remote.data, authDatabaseFrom(context.env)),
        tombstones: tombstonesFrom(context.env),
    };
};

/**
 * The privacy configuration, written once. `definePrivacy` binds it, and the workflow's port
 * dispatcher (`privacyPort` in `requests.ts`) reads the same object, so both sides look a dataset
 * up and judge a row the same way.
 */
export const privacyConfig: PrivacyConfig<PrivacyContext> = {
    // `signInTokens` comes before `authData`: erasing the user row removes the address its rows are matched by.
    datasets: [tasksData, billingData, signInTokens, authData],
    ports: (context) => ("db" in context ? localPorts(context) : workflowPorts(context)),
    presets,
    tombstoneSecret,
};

export const privacyFor = definePrivacy(privacyConfig);

/**
 * After a point-in-time restore of the shard, erase again every restored subject the tombstone store
 * says was erased. The package reads the tombstone keys and re-runs each dataset's erasure, which is
 * idempotent, so a retried step finishes the work rather than repeating it. Returns the re-erased ids.
 */
const restoreHandler = async (context: WorkflowRunContext<RestoreParameters>): Promise<string[]> => {
    const reerased = await context.step.do("restore", async () => [
        ...(await privacyFor(context).restore({ restoredSubjectIds: context.params.restoredSubjectIds })),
    ]);

    // A restore can bring back archived rows whose retention period has already ended. The sweep purges them now, rather than
    // leaving them until the next daily run.
    await context.step.do("purge", async () => {
        await privacyFor(context).admin.sweep();
    });

    return reerased;
};

/**
 * The durable handlers. Each one binds the ports from its own context, so the step
 * functions run against the database through `ctx.run`.
 */
export const privacyWorkflows = {
    erasureHandler: async (context: WorkflowRunContext<{ requestId: string }>): Promise<void> => privacyFor(context).workflows.erasureHandler(context),
    exportHandler: async (context: WorkflowRunContext<{ requestId: string }>): Promise<void> => privacyFor(context).workflows.exportHandler(context),
    restoreHandler,
};
