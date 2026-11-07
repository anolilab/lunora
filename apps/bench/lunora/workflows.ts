/**
 * Durable workflows — codegen turns each `defineWorkflow` export into a
 * `WorkflowEntrypoint` class (re-exported from `lunora/server.ts`) and wires
 * `ctx.workflows.get("<name>")` on mutations and actions.
 */
import { defineWorkflow } from "@lunora/workflow";

import { internal } from "./_generated/internal";

/**
 * A new organisation's first week: seed a starter task, send the welcome mail,
 * and nudge after a day if nothing was created. Every `ctx.run` names the
 * tenant's shard, so the writes land where the tenant's rows live.
 */
export const onboarding = defineWorkflow<{ email: string; organizationId: string; userId: string }, { nudged: boolean }>({
    handler: async (ctx) => {
        // `email` is the starter's verified address from their identity, never from the request; see `lunora/onboarding.ts`.
        const { email, organizationId, userId } = ctx.params;
        const instanceKey = `onboarding-${organizationId}`;

        await ctx.step.do("seed", () => ctx.run(internal.onboarding.seedOrganization, { organizationId, userId }, { shardKey: organizationId }));
        // A stable key per mail: a restarted instance replays these steps, and the provider drops a repeat of the same key.
        await ctx.step.do("welcome", () =>
            ctx.run(internal.mail.sendEmail, {
                idempotencyKey: `${instanceKey}:welcome`,
                subject: "Welcome to the bench",
                text: "Your workspace is ready.",
                to: email,
            }),
        );
        await ctx.step.sleep("settle", "1 day");

        // `ctx.run` resolves to `unknown` whatever the reference returns (FINDINGS.md), so the shape is restated here.
        const { tasks } = (await ctx.step.do("count", () => ctx.run(internal.onboarding.progress, { organizationId }, { shardKey: organizationId }))) as {
            tasks: number;
        };

        if (tasks > 1) {
            return { nudged: false };
        }

        // The starter may have been removed since the welcome mail: a former member is not nudged.
        const { member } = (await ctx.step.do("member", () => ctx.run(internal.membership.isMember, { organizationId, userId }, { shardKey: "__root__" }))) as {
            member: boolean;
        };

        if (!member) {
            return { nudged: false };
        }

        await ctx.step.do("nudge", () =>
            ctx.run(internal.mail.sendEmail, {
                idempotencyKey: `${instanceKey}:nudge`,
                subject: "Your first task is waiting",
                text: "Create a task to get going.",
                to: email,
            }),
        );

        return { nudged: true };
    },
});
