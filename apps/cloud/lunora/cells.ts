import { LunoraError } from "@lunora/server";

import type { Id } from "./_generated/dataModel.js";
import { internalMutation, query, v } from "./_generated/server.js";

/**
 * The cell fields safe to expose to any signed-in user (the org-create picker).
 * Deliberately omits infra identifiers (`cloudflareAccountId`,
 * `dispatchNamespacePrefix`) — those are operator-only and must not leak
 * fleet-wide. Mirrored as a local interface so codegen inlines the return type.
 */
interface CellSummary {
    _id: Id<"cells">;
    jurisdiction?: string;
    name: string;
    status: "active" | "draining" | "suspended";
}

/**
 * List every cell (Cloudflare account) the fleet spans (§2.5). Platform-admin
 * surface — a real deployment gates this behind a platform-operator role.
 * `cells` is `.global()`, so reads go through the D1-backed per-table facade.
 */
export const list = query.query(async ({ ctx: context }): Promise<CellSummary[]> => {
    // Any signed-in user picks a cell when creating an org, so this stays sign-in
    // gated — but it returns only the picker-safe projection (no Cloudflare account
    // ids / dispatch prefixes). A dedicated platform-operator role remains the
    // proper gate for the full fleet view (follow-up — no operator role exists yet).
    if (!context.auth.userId) {
        throw new LunoraError("UNAUTHORIZED", "not signed in");
    }

    const { page } = await context.db.cells.findMany();

    return page.map((cell) => {
        return {
            _id: cell._id,
            jurisdiction: cell.jurisdiction,
            name: cell.name,
            status: cell.status,
        };
    });
});

/**
 * Register a new cell. Provisioning the underlying Cloudflare account +
 * dispatch namespaces is cell bring-up IaC (Alchemy, §2.2) and happens out of
 * band; this records the cell so orgs can be assigned to it.
 *
 * `internal` — registering a fleet cell is a platform-operator action, not a
 * tenant one. It is reachable only through the `LUNORA_ADMIN_TOKEN`-gated
 * `POST /v1/cells` route (the platform trust boundary), never public RPC, so a
 * signed-in tenant can no longer inject cells into the fleet topology. Mutations
 * can't read `ctx.env`, so the admin-secret check lives at the router.
 */
export const register = internalMutation
    .input({
        cloudflareAccountId: v.string(),
        dispatchNamespacePrefix: v.string(),
        jurisdiction: v.optional(v.string()),
        name: v.string(),
    })
    .mutation(async ({ ctx: context, args: arguments_ }): Promise<Id<"cells">> =>
        context.db.insert("cells", {
            cloudflareAccountId: arguments_.cloudflareAccountId,
            createdAt: context.now,
            dispatchNamespacePrefix: arguments_.dispatchNamespacePrefix,
            jurisdiction: arguments_.jurisdiction,
            name: arguments_.name,
            status: "active",
        }),
    );
