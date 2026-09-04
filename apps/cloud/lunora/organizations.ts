import { LunoraError } from "@lunora/server";

import type { Id } from "./_generated/dataModel.js";
import { internalMutation, mutation, query, v } from "./_generated/server.js";
import { assertMember } from "./authz";
import { rateLimit } from "./guards";
import { boundedString, LIMITS } from "./validators";

/**
 * An organization as the dashboard consumes it.
 *
 * The suspension / pending-deletion columns are part of the contract, not an
 * afterthought: the studio's org banners key on them (GAPS.md C1/C2/D3). They were
 * absent from this type while the rows carried them at runtime, so the UI had to
 * re-declare a local shape and cast to it — and the cast typed them as
 * `number | undefined` when D1 actually returns `null`, which silently made every
 * "is it suspended?" test false. Declared `| null` here so callers must handle the
 * value the backend really sends.
 */
interface OrganizationRow {
    _id: Id<"organizations">;
    cellId: Id<"cells">;
    createdAt: number;
    /** Set when an owner requested erasure; the purge cron acts after the retention window. */
    deletionRequestedAt?: null | number;
    name: string;
    plan: "enterprise" | "free" | "pro";
    slug: string;
    /** Set by the spend-cap / dunning enforcement crons (or support). */
    suspendedAt?: null | number;
    /** Which mechanism suspended the org — `"spend-cap"`, `"dunning"` or `"support"`. */
    suspendedReason?: null | string;
}

const assertSignedIn = (userId: null | string): string => {
    if (!userId) {
        throw new LunoraError("UNAUTHORIZED", "not signed in");
    }

    return userId;
};

/**
 * The organizations the signed-in caller belongs to (the dashboard's org list).
 * Scoped to the caller's memberships — returning every org leaked the full tenant
 * roster (enumeration) to any caller. `.global()` → D1 facade.
 */
export const list = query.query(async ({ ctx: context }): Promise<OrganizationRow[]> => {
    const { userId } = context.auth;

    if (!userId) {
        throw new LunoraError("UNAUTHORIZED", "not signed in");
    }

    const { page: memberships } = await context.db.members.findMany({ where: { userId } });
    const orgIds = [...new Set(memberships.map((membership) => membership.organizationId))];

    // Fetched BY ID rather than read-all-and-filter. The previous form pulled one
    // page of every organization on the platform and kept the caller's — which is
    // not just wasteful but wrong past a page: an org outside the first 1000 was
    // silently missing from its own member's switcher, with nothing to indicate
    // the list was truncated. The read now scales with the caller's memberships,
    // which is what the answer depends on.
    const organizations = await Promise.all(orgIds.map(async (id) => (await context.db.get(id)) as null | OrganizationRow));

    return organizations.filter((organization): organization is OrganizationRow => organization !== null);
});

/**
 * Look an organization up by its URL slug.
 *
 * Filtered in the QUERY, through the `by_slug` unique index. Reading every
 * organization and matching in memory was justified by "org volume is tiny",
 * which is an assumption that fails silently rather than loudly: past one page
 * the lookup simply returned null, and the member was told their org does not
 * exist. The index that makes this a point read was already declared.
 */
export const getBySlug = query.input({ slug: boundedString(LIMITS.id) }).query(async ({ ctx: context, args: { slug } }): Promise<OrganizationRow | null> => {
    const { userId } = context.auth;

    if (!userId) {
        return null;
    }

    const { page } = await context.db.organizations.findMany({ where: { slug } });
    const organization = page[0] ?? null;

    if (!organization) {
        return null;
    }

    // Only reveal the org to its own members. A non-member (or signed-out caller)
    // gets `null` — identical to not-found — so this can neither leak cross-tenant
    // org metadata nor act as a slug-enumeration oracle.
    const { page: membership } = await context.db.members.findMany({ where: { organizationId: organization._id, userId } });

    return membership.length > 0 ? organization : null;
});

/**
 * Create an organization on a given cell, seed its creator as `owner`, and
 * record the action in the audit log. Slug uniqueness is enforced by the
 * `by_slug` global (D1) unique index.
 *
 * Carries no CAPTCHA, so `user_creating_mutation_without_captcha` flags it (the
 * lint keys on the `members` insert below, which matches its user/session-table
 * pattern). Accepted deliberately: this is a *signed-in* endpoint, so a bot must
 * already have cleared better-auth's sign-up + email verification — which is
 * where the human check belongs, and where better-auth's own `rateLimit` runs.
 * The abuse ceiling here is the `provision` bucket. Same reasoning applies to
 * `members.add` and `invitations.accept`.
 */
export const create = mutation
    .use(rateLimit("provision"))
    .input({
        // Explicit cell placement; omit to let `jurisdiction` (or the default
        // pool) pick an active cell (GAPS.md F data-residency).
        cellId: v.optional(v.id("cells")),
        // "eu" | "fedramp" — restricts placement to cells in that jurisdiction.
        jurisdiction: v.optional(boundedString(LIMITS.tag)),
        name: boundedString(LIMITS.name),
        plan: v.optional(v.union(v.literal("free"), v.literal("pro"), v.literal("enterprise"))),
        slug: boundedString(LIMITS.id),
    })
    .mutation(async ({ ctx: context, args: arguments_ }): Promise<Id<"organizations">> => {
        const userId = assertSignedIn(context.auth.userId);
        const { now } = context;

        let { cellId } = arguments_;

        if (!cellId) {
            const { page: cellPage } = await context.db.cells.findMany({});
            const candidate = cellPage.find(
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
    .use(rateLimit("api"))
    .input({
        name: boundedString(LIMITS.name),
        organizationId: v.id("organizations"),
    })
    .mutation(async ({ ctx: context, args: { name, organizationId } }): Promise<void> => {
        const member = await assertMember(context, organizationId, ["owner"]);
        const { now } = context;

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
    .use(rateLimit("sensitive"))
    .input({ organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { organizationId } }): Promise<void> => {
        const member = await assertMember(context, organizationId, ["owner"]);
        const { now } = context;

        await context.db.patch(organizationId, { deletionRequestedAt: now });
        await context.db.insert("auditLog", { action: "organization.deletion.request", actorUserId: member.userId, createdAt: now, organizationId });
    });

/** Cancel a pending deletion request (owner only). */
export const cancelDeletion = mutation
    .use(rateLimit("api"))
    .input({ organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { organizationId } }): Promise<void> => {
        const member = await assertMember(context, organizationId, ["owner"]);
        const { now } = context;

        await context.db.patch(organizationId, { deletionRequestedAt: null });
        await context.db.insert("auditLog", { action: "organization.deletion.cancel", actorUserId: member.userId, createdAt: now, organizationId });
    });

/** Organizations one purge tick erases. Bounds a single mutation; a backlog drains over ticks. */
const PURGE_BATCH = 100;

/**
 * Purge orgs whose deletion request has aged past the retention window
 * (GAPS.md D3 right-to-erasure). Erases the org's control-plane rows across
 * every org-scoped table, marks its deployments destroyed (the provisioner
 * teardown of live scripts/D1/R2 is the 🌐 half, driven off the destroyed
 * status), and finally deletes the org row itself. SYSTEM only (cron).
 */
export const purgeDeleted = internalMutation.mutation(async ({ ctx: context }): Promise<{ purged: number }> => {
    const cutoff = context.now - DELETION_RETENTION_MS;
    // The cutoff is a `where` predicate, so the page holds only organizations that are
    // actually due. That also settles `deletionRequestedAt` being optional: SQL `<`
    // never matches NULL, so organizations that were never scheduled for deletion are
    // excluded by the query rather than crowding out the ones that were. Oldest-first
    // within the due set, bounded per tick.
    const { page } = await context.db.organizations.findMany({
        limit: PURGE_BATCH,
        orderBy: [{ deletionRequestedAt: "asc" }],
        where: { deletionRequestedAt: { lt: cutoff } },
    });
    const due = page;

    // EVERY table carrying an `organizationId`, not a hand-kept subset. The list
    // had drifted to 12 of 25 while the docblock above claimed erasure "across
    // every org-scoped table" — so a right-to-erasure purge left the org's
    // telemetry (`observations`, `metricPoints`, `issues`/`incidents` bodies, all
    // of which can carry end-user data), its live alert destinations, and — the
    // sharpest one — its envelope-encrypted Cloudflare billing token in
    // `cloudflareBilling`, orphaned with no org row left to key a future sweep off.
    //
    // Two deliberate exceptions to "every table with an organizationId":
    // `deployments` is NOT hard-deleted here — the block below transitions it to
    // `destroyed` so the teardown path can still reach the live dispatch script,
    // D1 and R2; deleting the row first would leak all three. And
    // `githubInstallations` IS included even though its `organizationId` is
    // optional, which is why it cannot simply be derived from the schema.
    //
    // Kept as an explicit literal rather than derived at runtime because codegen
    // types `context.db.delete` per table; the guard against it drifting again is
    // the test that diffs this list against the schema.
    const orgScopedTables = [
        "alertRuleState",
        "alertRules",
        "alerts",
        "aliasOwnership",
        "auditLog",
        "buildLogs",
        "builds",
        "cloudflareBilling",
        "dashboards",
        "deployKeys",
        "domains",
        "githubInstallations",
        "incidents",
        "invitations",
        "issues",
        "members",
        "metricPoints",
        "observations",
        "overageDebits",
        "platformUsage",
        "projects",
        "secrets",
        "tenantLogs",
        "uptimeChecks",
        "uptimeState",
    ] as const;

    for (const organization of due) {
        const organizationId = organization._id;

        for (const table of orgScopedTables) {
            // The per-table facade types don't unify, so the generic sweep goes
            // through a minimal structural cast.
            const facade = context.db[table] as unknown as {
                findMany: (q: { where: Record<string, unknown> }) => Promise<{ page: { _id: string }[] }>;
            };
            // eslint-disable-next-line no-await-in-loop -- sequential per-table purge keeps the writer simple
            const { page: rows } = await facade.findMany({ where: { organizationId } });

            for (const row of rows) {
                // eslint-disable-next-line no-await-in-loop -- sequential deletes; volumes are small
                await context.db.delete(row._id as never);
            }
        }

        // Deployments transition to destroyed (not hard-deleted) so the 🌐
        // teardown path still sees what to tear down; a later sweep removes rows.
        // eslint-disable-next-line no-await-in-loop -- one read per org; volumes are small
        const { page: deployments } = await context.db.deployments.findMany({ where: { organizationId } });

        for (const deployment of deployments) {
            // eslint-disable-next-line no-await-in-loop -- sequential patches; volumes are small
            await context.db.patch(deployment._id, { destroyedAt: context.now, status: "destroyed", updatedAt: context.now });
        }

        // eslint-disable-next-line no-await-in-loop -- one delete per org
        await context.db.delete(organizationId);
    }

    return { purged: due.length };
});

/**
 * Persist the org's Creem credits-account id after the first credit-pack
 * purchase created it (GAPS.md C3 prepaid overage). Never overwrites an
 * existing id — an account, once linked, stays linked. SYSTEM only
 * (billing-webhook post-processing dispatch).
 */
export const linkCreditsAccount = internalMutation
    .input({ creditsAccountId: v.string(), organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { creditsAccountId, organizationId } }): Promise<void> => {
        const organization = (await context.db.get(organizationId)) as null | (OrganizationRow & { creditsAccountId?: string });

        if (!organization || organization.creditsAccountId != null) {
            return;
        }

        await context.db.patch(organizationId, { creditsAccountId });
    });
