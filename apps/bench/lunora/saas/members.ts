/**
 * The `saas_members` reader, typed by the generated per-table facade. The table is
 * `.global()`, so a tenant shard reads it through `ctx.db` the same way it reads the
 * organisation projection.
 */
import type { MutationCtx, QueryCtx, TableReaderFacade } from "#lunora/_generated/server.js";

import { SAAS_MEMBERS_TABLE } from "./schema";

export const membersOf = (ctx: MutationCtx | QueryCtx): TableReaderFacade<"saas_members"> => ctx.db[SAAS_MEMBERS_TABLE];

/** Whether `userId` belongs to `organizationId`, read from the projection a tenant can see. */
export const isOrganizationMember = async (ctx: MutationCtx, organizationId: string, userId: string): Promise<boolean> => {
    const row = await membersOf(ctx).findFirst({ where: { organizationId, userId } });

    return Boolean(row);
};
