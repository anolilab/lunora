/**
 * Durable workflows — codegen turns each `defineWorkflow` export into a
 * `WorkflowEntrypoint` class (re-exported from `lunora/server.ts`) and wires
 * `ctx.workflows.get("<name>")` on mutations and actions.
 */
import { defineWorkflow } from "@lunora/workflow";

import { internal } from "./_generated/internal";

/**
 * Send one onboarding mail. If the send fails for good, `release` gives its claim
 * back first, so a later run of the instance can send it; the failure is rethrown.
 */
const sendOrRelease = async (release: () => Promise<unknown>, send: () => Promise<unknown>): Promise<void> => {
    try {
        await send();
    } catch (error) {
        await release();

        throw error;
    }
};

/**
 * A new organisation's first week: seed a starter task, send the welcome mail,
 * and nudge after a day if the team has created no task. Every `ctx.run` names the
 * tenant's shard, so the writes land where the tenant's rows live. The welcome and
 * the nudge are each claimed once per organisation on the root shard before the
 * send: a restarted instance runs every step again, and the claim keeps either mail
 * from going out twice.
 */
export const onboarding = defineWorkflow<{ email: string; organizationId: string; userId: string }, { nudged: boolean }>({
    handler: async (ctx) => {
        // `email` is the starter's verified address from their identity, never from the request; see `lunora/onboarding.ts`.
        const { email, organizationId, userId } = ctx.params;
        const instanceKey = `onboarding-${organizationId}`;

        // Read inside each step that writes or sends, so a removal after the start check is seen before the side effect.
        const starterIsMember = async (): Promise<boolean> => {
            const { member } = (await ctx.run(internal.membership.isMember, { organizationId, userId }, { shardKey: "__root__" })) as { member: boolean };

            return member;
        };

        // A starter removed from the organisation before it starts gets no seed and no mail.
        const { member: startedAsMember } = (await ctx.step.do("member at start", () =>
            ctx.run(internal.membership.isMember, { organizationId, userId }, { shardKey: "__root__" }),
        )) as { member: boolean };

        if (!startedAsMember) {
            return { nudged: false };
        }

        const { seeded } = await ctx.step.do("seed", async () => {
            if (!(await starterIsMember())) {
                return { seeded: false };
            }

            await ctx.run(internal.onboarding.seedOrganization, { organizationId, userId }, { shardKey: organizationId });

            return { seeded: true };
        });

        if (!seeded) {
            return { nudged: false };
        }

        const { claimed: welcomed } = (await ctx.step.do("claim welcome", () =>
            ctx.run(internal.saas.claimMail, { kind: "welcome", organizationId }, { shardKey: "__root__" }),
        )) as { claimed: boolean };

        if (welcomed) {
            await sendOrRelease(
                () => ctx.step.do("release welcome", () => ctx.run(internal.saas.releaseMail, { kind: "welcome", organizationId }, { shardKey: "__root__" })),
                () =>
                    ctx.step.do("welcome", async () => {
                        if (!(await starterIsMember())) {
                            return;
                        }

                        await ctx.run(internal.mail.sendEmail, {
                            idempotencyKey: `${instanceKey}:welcome`,
                            subject: "Welcome to the bench",
                            text: "Your workspace is ready.",
                            to: email,
                        });
                    }),
            );
        }

        await ctx.step.sleep("settle", "1 day");

        // The team's own tasks only: the starter is not counted, so a nudge goes to a team that has done nothing yet.
        const { tasks } = (await ctx.step.do("count", () => ctx.run(internal.onboarding.progress, { organizationId }, { shardKey: organizationId }))) as {
            tasks: number;
        };

        if (tasks > 0) {
            return { nudged: false };
        }

        // The starter may have been removed since the welcome mail: a former member is not nudged.
        const { member } = (await ctx.step.do("member", () => ctx.run(internal.membership.isMember, { organizationId, userId }, { shardKey: "__root__" }))) as {
            member: boolean;
        };

        if (!member) {
            return { nudged: false };
        }

        const { claimed: nudged } = (await ctx.step.do("claim nudge", () =>
            ctx.run(internal.saas.claimMail, { kind: "nudge", organizationId }, { shardKey: "__root__" }),
        )) as { claimed: boolean };

        if (!nudged) {
            return { nudged: false };
        }

        await sendOrRelease(
            () => ctx.step.do("release nudge", () => ctx.run(internal.saas.releaseMail, { kind: "nudge", organizationId }, { shardKey: "__root__" })),
            () =>
                ctx.step.do("nudge", () =>
                    ctx.run(internal.mail.sendEmail, {
                        idempotencyKey: `${instanceKey}:nudge`,
                        subject: "Your first task is waiting",
                        text: "Create a task to get going.",
                        to: email,
                    }),
                ),
        );

        return { nudged: true };
    },
});
