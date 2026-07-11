import { LunoraError } from "@lunora/server";

import type { Id } from "./_generated/dataModel.js";
import { internalMutation, mutation, query, v } from "./_generated/server.js";
import { assertMember } from "./authz";

interface OrganizationRow {
    _id: Id<"organizations">;
    cellId: Id<"cells">;
    createdAt: number;
    name: string;
    plan: "enterprise" | "free" | "pro";
    slug: string;
}

const assertSignedIn = (userId: null | string): string => {
    if (!userId) {
        throw new LunoraError("UNAUTHORIZED", "not signed in");
    }

    return userId;
};

/** List all organizations (platform-admin surface). `.global()` → D1 facade. */
export const list = query.query(async ({ ctx: context }): Promise<OrganizationRow[]> => {
    const { page } = await context.db.organizations.findMany();

    return page as unknown as OrganizationRow[];
});

/**
 * Look an organization up by its URL slug. `organizations` is `.global()`, so
 * we read through the facade and match in memory — org volume is tiny, and the
 * `by_slug` unique index still enforces correctness on insert.
 */
export const getBySlug = query.input({ slug: v.string() }).query(async ({ ctx: context, args: { slug } }): Promise<OrganizationRow | null> => {
    const { page } = await context.db.organizations.findMany();

    return (page as unknown as OrganizationRow[]).find((organization) => organization.slug === slug) ?? null;
});

/**
 * Create an organization on a given cell, seed its creator as `owner`, and
 * record the action in the audit log. Slug uniqueness is enforced by the
 * `by_slug` global (D1) unique index.
 */
export const create = mutation
    .input({
        // Explicit cell placement; omit to let `jurisdiction` (or the default
        // pool) pick an active cell (GAPS.md F data-residency).
        cellId: v.optional(v.id("cells")),
        // "eu" | "fedramp" — restricts placement to cells in that jurisdiction.
        jurisdiction: v.optional(v.string()),
        name: v.string(),
        plan: v.optional(v.union(v.literal("free"), v.literal("pro"), v.literal("enterprise"))),
        slug: v.string(),
    })
    .mutation(async ({ ctx: context, args: arguments_ }): Promise<Id<"organizations">> => {
        const userId = assertSignedIn(context.auth.userId);
        const now = Date.now();

        let { cellId } = arguments_;

        if (!cellId) {
            const { page: cellPage } = await context.db.cells.findMany({});
            const candidate = (cellPage as unknown as { _id: Id<"cells">; jurisdiction?: string; status: string }[]).find(
                (cell) => cell.status === "active" && (arguments_.jurisdiction === undefined || cell.jurisdiction === arguments_.jurisdiction),
            );
            const picked = candidate;

            if (!picked) {
                throw new LunoraError(
                    "UNPROCESSABLE",
                    arguments_.jurisdiction ? `no active cell in jurisdiction "${arguments_.jurisdiction}"` : "no active cell available",
                );
            }

            cellId = picked._id;
        }

        const organizationId = await context.db.insert("organizations", {
            cellId,
            createdAt: now,
            name: arguments_.name,
            plan: arguments_.plan ?? "free",
            slug: arguments_.slug,
        });

        await context.db.insert("members", {
            createdAt: now,
            organizationId,
            role: "owner",
            userId,
        });

        await context.db.insert("auditLog", {
            action: "organization.create",
            actorUserId: userId,
            createdAt: now,
            organizationId,
            target: arguments_.slug,
        });

        return organizationId;
    });

/** Rename an organization (owner only). The slug is immutable (it's the URL identity). */
export const rename = mutation
    .input({ name: v.string(), organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { name, organizationId } }): Promise<void> => {
        const member = await assertMember(context, organizationId, ["owner"]);
        const now = Date.now();

        await context.db.patch(organizationId, { name });
        await context.db.insert("auditLog", { action: "organization.rename", actorUserId: member.userId, createdAt: now, organizationId, target: name });
    });

/** Deletion grace window (GAPS.md D3): 30 days to change your mind before the purge. */
export const DELETION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Request org deletion (owner only, GAPS.md D3). Starts the retention window;
 * the purge cron erases everything once it passes. Reversible until then via
 * {@link cancelDeletion}.
 */
export const requestDeletion = mutation
    .input({ organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { organizationId } }): Promise<void> => {
        const member = await assertMember(context, organizationId, ["owner"]);
        const now = Date.now();

        await context.db.patch(organizationId, { deletionRequestedAt: now });
        await context.db.insert("auditLog", { action: "organization.deletion.request", actorUserId: member.userId, createdAt: now, organizationId });
    });

/** Cancel a pending deletion request (owner only). */
export const cancelDeletion = mutation
    .input({ organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { organizationId } }): Promise<void> => {
        const member = await assertMember(context, organizationId, ["owner"]);
        const now = Date.now();

        await context.db.patch(organizationId, { deletionRequestedAt: undefined });
        await context.db.insert("auditLog", { action: "organization.deletion.cancel", actorUserId: member.userId, createdAt: now, organizationId });
    });

/**
 * Purge orgs whose deletion request has aged past the retention window
 * (GAPS.md D3 right-to-erasure). Erases the org's control-plane rows across
 * every org-scoped table, marks its deployments destroyed (the provisioner
 * teardown of live scripts/D1/R2 is the 🌐 half, driven off the destroyed
 * status), and finally deletes the org row itself. SYSTEM only (cron).
 */
export const purgeDeleted = internalMutation.mutation(async ({ ctx: context }): Promise<{ purged: number }> => {
    const cutoff = Date.now() - DELETION_RETENTION_MS;
    const { page } = await context.db.organizations.findMany({});
    const due = (page as unknown as (OrganizationRow & { deletionRequestedAt?: number })[]).filter(
        (organization) => organization.deletionRequestedAt !== undefined && organization.deletionRequestedAt < cutoff,
    );

    const orgScopedTables = [
        "auditLog",
        "buildLogs",
        "builds",
        "deployKeys",
        "domains",
        "githubInstallations",
        "invitations",
        "members",
        "platformUsage",
        "projects",
        "secrets",
        "tenantLogs",
    ] as const;

    for (const organization of due) {
        const organizationId = organization._id;

        for (const table of orgScopedTables) {
            // The per-table facade types don't unify, so the generic sweep goes
            // through a minimal structural cast.
            const facade = context.db[table] as unknown as { findMany: (q: { where: Record<string, unknown> }) => Promise<{ page: unknown[] }> };
            // eslint-disable-next-line no-await-in-loop -- sequential per-table purge keeps the writer simple
            const { page: rows } = await facade.findMany({ where: { organizationId } });

            for (const row of rows as unknown as { _id: string }[]) {
                // eslint-disable-next-line no-await-in-loop -- sequential deletes; volumes are small
                await context.db.delete(row._id as never);
            }
        }

        // Deployments transition to destroyed (not hard-deleted) so the 🌐
        // teardown path still sees what to tear down; a later sweep removes rows.
        // eslint-disable-next-line no-await-in-loop -- one read per org; volumes are small
        const { page: deployments } = await context.db.deployments.findMany({ where: { organizationId } });

        for (const deployment of deployments as unknown as { _id: string; status: string }[]) {
            // eslint-disable-next-line no-await-in-loop -- sequential patches; volumes are small
            await context.db.patch(deployment._id as never, { destroyedAt: Date.now(), status: "destroyed", updatedAt: Date.now() });
        }

        // eslint-disable-next-line no-await-in-loop -- one delete per org
        await context.db.delete(organizationId);
    }

    return { purged: due.length };
});
