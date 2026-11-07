/**
 * Whether a user is still a member of an organisation, read from better-auth's
 * `member` table on the root shard. Tenant reads that a run or a workflow step
 * starts from a membership check first: the run or the step can outlive the
 * membership it began under, and a removed member must not keep reading or
 * being mailed.
 */
import { env as workerEnv } from "cloudflare:workers";

import { internalAction, v } from "./_generated/server";
import { getAuth } from "./auth";
import type { AuthEnv } from "./auth";

export const isMember = internalAction.input({ organizationId: v.string(), userId: v.string() }).action(async ({ args }): Promise<{ member: boolean }> => {
    const { adapter } = await getAuth(workerEnv as unknown as AuthEnv).$context;
    const count = await adapter.count({
        model: "member",
        where: [
            { field: "organizationId", value: args.organizationId },
            { field: "userId", value: args.userId },
        ],
    });

    return { member: count > 0 };
});
