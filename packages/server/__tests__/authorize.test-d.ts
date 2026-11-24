import type { EmptyArgs, QueryBuilder } from "../src/index";
import { authorize } from "../src/index";

/**
 * Type-level proof that `.use(authorize(...))` keeps the builder's full context: a field the
 * check does not read (`tenantId`) stays readable in the handler.
 */

interface RequestContext {
    tenantId: string;
    user: { canManageTeamMembers: boolean };
}

const expectTenant = (_value: string): void => undefined;

const check = (): void => {
    const query = null as unknown as QueryBuilder<RequestContext, EmptyArgs>;

    query.use(authorize<{ user: { canManageTeamMembers: boolean } }>((ctx) => ctx.user.canManageTeamMembers)).query(({ ctx }) => {
        expectTenant(ctx.tenantId);
    });
};

export default check;
