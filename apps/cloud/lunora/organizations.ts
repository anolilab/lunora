import { LunoraError } from "@lunora/server";

import { assertStatusMove } from "../src/deploy/status-transitions";
import { DELETION_RETENTION_MS } from "../src/lib/deletion-retention";
import type { Doc as Document_, Id, TableName } from "./_generated/dataModel.js";
import { internalMutation, mutation, query, v } from "./_generated/server.js";
import { assertMember, assertSignedIn } from "./authz";
import { releaseIdleAliases } from "./deployment-aliases";
import { queueCertificateReleases } from "./domains";
import { releaseEdgeRules } from "./edge";
import { orgPlan } from "./entitlements";
import { rateLimit } from "./guards";
import { anonymiseScopedRows, ERASED_REFERENCE, purgeScopedRows } from "./purge";
import schema from "./schema";
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
type OrganizationRow = Document_<"organizations">;

/**
 * The organizations the signed-in caller belongs to (the dashboard's org list).
 * Scoped to the caller's memberships — returning every org leaked the full tenant
 * roster (enumeration) to any caller. `.global()` → D1 facade.
 */
export const list = query.query(async ({ ctx: context }): Promise<OrganizationRow[]> => {
    const userId = assertSignedIn(context.auth.userId);

    const { page: memberships } = await context.db.members.findMany({ where: { userId } });
    const orgIds = [...new Set(memberships.map((membership) => membership.organizationId))];

    // Fetched BY ID, not read-all-and-filter: a single page of every organization on the
    // platform would silently drop any org past the first thousand from its member's
    // switcher, with nothing to say the list was truncated. The read scales with the
    // caller's memberships, which is what the answer depends on.
    const organizations = await Promise.all(orgIds.map(async (id) => await context.db.get(id)));
    const present = organizations.filter((organization): organization is OrganizationRow => organization !== null);

    // The plan shown is the one billing applies, read from the subscriptions; the stored column is only the creation default.
    return Promise.all(
        present.map(async (organization): Promise<OrganizationRow> => {
            return { ...organization, plan: await orgPlan(context, organization._id) };
        }),
    );
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
 * `invitations.accept`.
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
        slug: boundedString(LIMITS.id),
    })
    .mutation(async ({ ctx: context, args: arguments_ }): Promise<Id<"organizations">> => {
        const userId = assertSignedIn(context.auth.userId);
        const { now } = context;

        let { cellId } = arguments_;

        // An explicit cell must take new organizations, as an auto-candidate one must.
        if (cellId) {
            const cell = await context.db.get(cellId);

            if (cell?.status !== "active") {
                throw new LunoraError("UNPROCESSABLE", "that cell is not accepting new organizations");
            }
        }

        if (!cellId) {
            const { page: cellPage } = await context.db.cells.findMany({});
            const candidate = cellPage.find(
                (cell) => cell.status === "active" && (arguments_.jurisdiction === undefined || cell.jurisdiction === arguments_.jurisdiction),
            );
            if (!candidate) {
                throw new LunoraError(
                    "UNPROCESSABLE",
                    arguments_.jurisdiction ? `no active cell in jurisdiction "${arguments_.jurisdiction}"` : "no active cell available",
                );
            }

            cellId = candidate._id;
        }

        const organizationId = await context.db.insert("organizations", {
            cellId,
            createdAt: now,
            name: arguments_.name,
            // Every organization starts on free. A paid plan comes from a synced subscription,
            // never from the caller (`src/billing/plan-of.ts`).
            plan: "free",
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
        await context.db.insert("auditLog", {
            action: "organization.rename",
            actorUserId: member.userId,
            createdAt: now,
            organizationId: member.organizationId,
            target: name,
        });
    });

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
        await context.db.insert("auditLog", {
            action: "organization.deletion.request",
            actorUserId: member.userId,
            createdAt: now,
            organizationId: member.organizationId,
        });
    });

/** Cancel a pending deletion request (owner only). */
export const cancelDeletion = mutation
    .use(rateLimit("api"))
    .input({ organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { organizationId } }): Promise<void> => {
        const member = await assertMember(context, organizationId, ["owner"]);
        const { now } = context;

        await context.db.patch(organizationId, { deletionRequestedAt: null });
        await context.db.insert("auditLog", {
            action: "organization.deletion.cancel",
            actorUserId: member.userId,
            createdAt: now,
            organizationId: member.organizationId,
        });
    });

/** Organizations one purge tick erases. Bounds a single mutation; a backlog drains over ticks. */
const PURGE_BATCH = 100;

/** The `@lunora/payment` rows an organization erasure deletes outright. */
const PAYMENT_DELETE_TABLES = ["payment_customers", "payment_usageEvents"] as const;

/**
 * Tables with an `organizationId` that the purge does not hard-delete, each with the
 * step that handles it instead. Naming them here, with the reason, is what keeps
 * the derivation honest: a new exception needs a reason, not a silent omission.
 */
export const PURGED_ELSEWHERE: Readonly<Record<string, string>> = {
    aliasOwnership:
        "released by releaseIdleAliases: an alias names its tenant, so it stays claimed until the teardown sweep has destroyed that tenant; purged here, another organization could claim it and deploy onto the erased tenant's data",
    deployments:
        "transitioned to destroyed, not deleted, so the teardown path can still reach the live dispatch script, D1 and R2; the retention sweep removes the row later",
    edgeRules:
        "released by releaseEdgeRules, which deletes the rows whose rule is off; an applied rule stays on the zone until the edge-rule reconciler removes it, then its row",
    tenantBackups:
        "each row points at an R2 snapshot a mutation cannot delete; the tenant backup sweep deletes each snapshot whose project is gone, object first, then the row",
};

/**
 * The tables an organization purge hard-deletes: every table in the schema that has
 * an `organizationId` column, minus {@link PURGED_ELSEWHERE}. Derived, not listed, so
 * a table added with an `organizationId` is erased with no list to update.
 *
 * `githubInstallations` is included although its `organizationId` is optional: the
 * column is present in the table's shape either way.
 */
export const orgPurgeTables = (): TableName[] =>
    Object.entries(schema.tables)
        .filter(([name, table]) => "organizationId" in table.shape && !Object.hasOwn(PURGED_ELSEWHERE, name))
        .map(([name]) => name as TableName);

const ORG_PURGE_TABLES = orgPurgeTables();

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
    const { page: due } = await context.db.organizations.findMany({
        limit: PURGE_BATCH,
        orderBy: [{ deletionRequestedAt: "asc" }],
        where: { deletionRequestedAt: { lt: cutoff } },
    });

    for (const organization of due) {
        const organizationId = organization._id;

        // Before the domain rows go: they are what names each certificate to release.
        // eslint-disable-next-line no-await-in-loop -- one org purged at a time keeps the writer simple
        await queueCertificateReleases(context, { organizationId });
        // eslint-disable-next-line no-await-in-loop -- see above
        await purgeScopedRows(context, ORG_PURGE_TABLES, { organizationId });
        // The payment mirror is keyed by the organization id as its reference. The
        // customer record (email, provider id) and metered usage are personal or
        // operational data with no retention duty, so they are deleted. Payment and
        // subscription rows are financial records (AO § 147, HGB § 257): they keep
        // amounts, currency, dates and state, and lose the link to the organization
        // and the provider ids, then age out under the retention sweep.
        // eslint-disable-next-line no-await-in-loop -- see above
        await purgeScopedRows(context, PAYMENT_DELETE_TABLES, { referenceId: organizationId });
        // eslint-disable-next-line no-await-in-loop -- see above
        await anonymiseScopedRows(context, "payment_sessions", { referenceId: organizationId }, (row) => {
            return {
                providerSessionId: `erased:${row._id}`,
                referenceId: ERASED_REFERENCE,
                // The provider's subscription id is a provider id too. Replaced, not
                // cleared: the store refuses an explicit `undefined`, and a row that
                // never had one keeps the column absent.
                ...(typeof row["subscriptionId"] === "string" ? { subscriptionId: `erased:${row._id}` } : {}),
            };
        });
        // eslint-disable-next-line no-await-in-loop -- see above
        await anonymiseScopedRows(context, "payment_subscriptions", { referenceId: organizationId }, (row) => {
            return {
                providerSubscriptionId: `erased:${row._id}`,
                referenceId: ERASED_REFERENCE,
            };
        });
        // eslint-disable-next-line no-await-in-loop -- see above
        await releaseIdleAliases(context, { organizationId });
        // eslint-disable-next-line no-await-in-loop -- see above
        await releaseEdgeRules(context, organizationId);

        // Deployments transition to destroyed (not hard-deleted) so the 🌐
        // teardown path still sees what to tear down; a later sweep removes rows.
        // eslint-disable-next-line no-await-in-loop -- one read per org; volumes are small
        const { page: deployments } = await context.db.deployments.findMany({ where: { organizationId } });

        // A row already `destroyed` keeps its status and its `destroyedAt`: it is not moved, so it is skipped
        // rather than re-written (`destroyed → destroyed` is not a move the table lists).
        const toDestroy = deployments.filter((deployment) => deployment.status !== "destroyed");

        for (const deployment of toDestroy) {
            assertStatusMove(deployment.status, "destroyed");
        }

        for (const deployment of toDestroy) {
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
