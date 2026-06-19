import { LunoraError } from "@lunora/server";

import type { Id } from "./_generated/dataModel.js";
import { mutation, query, v } from "./_generated/server.js";

interface CellRow {
    _id: Id<"cells">;
    cloudflareAccountId: string;
    createdAt: number;
    dispatchNamespacePrefix: string;
    jurisdiction?: string;
    name: string;
    status: "active" | "draining" | "suspended";
}

const assertSignedIn = (userId: null | string): string => {
    if (!userId) {
        throw new LunoraError("UNAUTHORIZED", "not signed in");
    }

    return userId;
};

/**
 * List every cell (Cloudflare account) the fleet spans (§2.5). Platform-admin
 * surface — a real deployment gates this behind a platform-operator role.
 * `cells` is `.global()`, so reads go through the D1-backed per-table facade.
 */
export const list = query.query(async ({ ctx: context }): Promise<CellRow[]> => {
    const { page } = await context.db.cells.findMany();

    return page as unknown as CellRow[];
});

/**
 * Register a new cell. Provisioning the underlying Cloudflare account +
 * dispatch namespaces is cell bring-up IaC (Alchemy, §2.2) and happens out of
 * band; this records the cell so orgs can be assigned to it.
 */
export const register = mutation
    .input({
        cloudflareAccountId: v.string(),
        dispatchNamespacePrefix: v.string(),
        jurisdiction: v.optional(v.string()),
        name: v.string(),
    })
    .mutation(async ({ ctx: context, args: arguments_ }): Promise<Id<"cells">> => {
        assertSignedIn(context.auth.userId);

        return context.db.insert("cells", {
            cloudflareAccountId: arguments_.cloudflareAccountId,
            createdAt: Date.now(),
            dispatchNamespacePrefix: arguments_.dispatchNamespacePrefix,
            jurisdiction: arguments_.jurisdiction,
            name: arguments_.name,
            status: "active",
        });
    });
