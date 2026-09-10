import { LunoraError } from "@lunora/server";

import { randomSecret, sha256Hex } from "../src/deploy/keys";
import { constantTimeEqual } from "../src/security/constant-time-equal";
import type { Id } from "./_generated/dataModel.js";
import { internalQuery, mutation, query, v } from "./_generated/server.js";
import { assertMember, assertRowInOrg } from "./authz";
import { assertWithinQuota } from "./entitlements";
import { rateLimit } from "./guards";
import { purgeScopedRows } from "./purge";
import { boundedString, LIMITS } from "./validators";

/** Shortest preview password accepted — a gate this weak is theatre below it. */
const MIN_PREVIEW_PASSWORD_LENGTH = 8;

interface ProjectRow {
    _id: Id<"projects">;
    activeDeploymentId?: string;
    createdAt: number;
    framework?: string;
    githubRepo?: string;
    name: string;
    organizationId: Id<"organizations">;
    previewPasswordHash?: string;
    previewPasswordSalt?: string;
    rollout?: { deploymentId: Id<"deployments">; percent: number; scriptName: string };
    slug: string;
}

/**
 * A project as the dashboard sees it.
 *
 * Explicitly projected rather than returning the stored row. `projects` now
 * carries the preview-password hash and its salt, and a table whose rows are
 * handed back wholesale exfiltrates every column added to it later — the row
 * shape and the wire shape have to be two different types for that to stay
 * impossible. Protection is reported as a boolean; the hash never leaves the
 * control plane.
 */
export interface ProjectView {
    _id: Id<"projects">;
    /** The deployment currently serving the stable URL, when one has been activated. */
    activeDeploymentId?: string;
    createdAt: number;
    framework?: string;
    githubRepo?: string;
    name: string;
    organizationId: Id<"organizations">;
    /** Whether preview deployments for this project require a password. */
    previewProtected: boolean;
    /** The staged rollout in progress, if any — candidate and share travel together by construction. */
    rollout?: { deploymentId: Id<"deployments">; percent: number; scriptName: string };
    slug: string;
}

/** Project one stored row onto the public view, dropping the protection secrets. */
export const toProjectView = (row: ProjectRow): ProjectView => {
    return {
        _id: row._id,
        createdAt: row.createdAt,
        name: row.name,
        organizationId: row.organizationId,
        previewProtected: Boolean(row.previewPasswordHash),
        slug: row.slug,
        ...(row.framework === undefined ? {} : { framework: row.framework }),
        ...(row.githubRepo === undefined ? {} : { githubRepo: row.githubRepo }),
        ...(row.activeDeploymentId === undefined ? {} : { activeDeploymentId: row.activeDeploymentId }),
        ...(row.rollout === undefined ? {} : { rollout: row.rollout }),
    };
};

/** List an organization's projects. */
export const listByOrg = query
    .input({ organizationId: v.id("organizations") })
    .query(async ({ ctx: context, args: { organizationId } }): Promise<ProjectView[]> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.projects.findMany({ where: { organizationId } });

        return page.map((row) => toProjectView(row));
    });

/**
 * Resolve a project by its connected GitHub repository (`owner/name`).
 *
 * SYSTEM only. Its one caller is the HMAC-verified GitHub webhook route, but as a
 * PUBLIC query it was also an unauthenticated oracle on the tenant RPC surface:
 * post a repository name, learn whether it is deployed here and get back the
 * internal `organizationId`/`projectId` that own it. Every function that acts on
 * those ids checks membership, so this was disclosure rather than escalation —
 * but it is the read an attacker uses to choose a target. Unlike `planForScript`
 * and the two route resolvers, it carried no "public by design" justification and
 * sat behind no admin-token gate.
 */
export const byGithubRepo = internalQuery
    .input({ repository: boundedString(LIMITS.token) })
    .query(async ({ ctx: context, args: { repository } }): Promise<null | { organizationId: Id<"organizations">; projectId: Id<"projects">; slug: string }> => {
        const { page } = await context.db.projects.findMany({ where: { githubRepo: repository } });
        const project = page[0];

        return project ? { organizationId: project.organizationId, projectId: project._id, slug: project.slug } : null; // secret-scanner:allow -- domain field name
    });

/**
 * Create a project in an organization. Per-org slug uniqueness is enforced by
 * the composite `by_org_slug` unique index; the org's live entitlements cap
 * project count (resolved from its synced subscription state, not the static
 * `plan` column — see `lunora/entitlements.ts`).
 */
export const create = mutation
    .use(rateLimit("provision"))
    .input({
        framework: v.optional(boundedString(LIMITS.id)),
        githubRepo: v.optional(boundedString(LIMITS.token)),
        name: boundedString(LIMITS.name),
        organizationId: v.id("organizations"),
        slug: boundedString(LIMITS.id),
    })
    .mutation(async ({ ctx: context, args: arguments_ }): Promise<Id<"projects">> => {
        await assertMember(context, arguments_.organizationId, ["owner", "admin", "member"]);

        const { page } = await context.db.projects.findMany({ where: { organizationId: arguments_.organizationId } });

        await assertWithinQuota(context, arguments_.organizationId, "projects", page.length);

        return context.db.insert("projects", {
            createdAt: context.now,
            framework: arguments_.framework,
            githubRepo: arguments_.githubRepo,
            name: arguments_.name,
            organizationId: arguments_.organizationId,
            slug: arguments_.slug,
        });
    });

/** Rename a project (owner/admin). The slug (and its URL alias) is immutable. */
export const rename = mutation
    .use(rateLimit("api"))
    .input({
        id: v.id("projects"),
        name: boundedString(LIMITS.name),
        organizationId: v.id("organizations"),
    })
    .mutation(async ({ ctx: context, args: { id, name, organizationId } }): Promise<void> => {
        const member = await assertMember(context, organizationId, ["owner", "admin"]);

        await assertRowInOrg(context, id, organizationId, "project");
        await context.db.patch(id, { name });
        await context.db.insert("auditLog", { action: "project.rename", actorUserId: member.userId, createdAt: context.now, organizationId, target: name });
    });

/**
 * Project-scoped tables erased when a project is removed.
 *
 * Deliberately the project's OWN rows only. Org-scoped tables (`members`,
 * `deployKeys`, `auditLog`, billing) survive — deleting a project is not
 * deleting the org, and `organizations.purgeDeleted` is the operation that does
 * that.
 *
 * `deployments` is absent for the same reason it is absent there: they are
 * transitioned to `destroyed` below so the teardown sweep can still reach the
 * live dispatch script, tenant D1 and R2. Deleting the row first orphans all
 * three, which is a resource leak with a monthly bill attached.
 */
const PROJECT_SCOPED_TABLES = ["aliasOwnership", "buildLogs", "builds", "domains", "secrets"] as const;

/**
 * Delete a project and everything scoped to it (owners/admins).
 *
 * Projects could be created and renamed but never removed — the only way out was
 * deleting the whole organization, which is a far larger and slower action than
 * "I made this by mistake" warrants.
 *
 * Immediate rather than a retention window, unlike org deletion: an org holds
 * billing history and member identities that a regulator or an accountant may
 * need, while a project holds the tenant's own build artefacts. What it shares
 * with org deletion is the teardown contract — deployments go to `destroyed` and
 * the existing sweep reclaims the real Cloudflare resources — so this reuses that
 * path rather than inventing a second one.
 *
 * Audited, because it is destructive and irreversible.
 */
export const remove = mutation
    .use(rateLimit("sensitive"))
    .input({ id: v.id("projects"), organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { id, organizationId } }): Promise<{ destroyed: number }> => {
        const member = await assertMember(context, organizationId, ["owner", "admin"]);

        await assertRowInOrg(context, id, organizationId, "project");

        const { now } = context;

        await purgeScopedRows(context, PROJECT_SCOPED_TABLES, { projectId: id });

        // Deployments transition rather than vanish, so the teardown sweep still
        // has something to tear down.
        const { page: deployments } = await context.db.deployments.findMany({ where: { projectId: id } });
        const live = deployments.filter((row) => row.status !== "destroyed");

        for (const deployment of live) {
            // eslint-disable-next-line no-await-in-loop -- sequential patches; a project's volumes are small
            await context.db.patch(deployment._id, { destroyedAt: now, status: "destroyed", updatedAt: now });
        }

        await context.db.delete(id);
        await context.db.insert("auditLog", {
            action: "project.delete",
            actorUserId: member.userId,
            createdAt: now,
            organizationId,
            target: id,
        });

        return { destroyed: live.length };
    });

/**
 * Turn deployment protection on or off for a project's PREVIEW deployments.
 *
 * A preview URL is publicly addressable the moment it exists — that is what
 * makes it useful, and also what serves unreleased work to anyone forwarded the
 * link. Passing a password turns the gate on; passing `null` turns it off.
 *
 * Only the salted SHA-256 is stored. The plaintext is never persisted and never
 * returned, so a lost password is reset rather than recovered — the same posture
 * as a deploy key, and for the same reason.
 *
 * Owners/admins only, and audited: enabling or removing a gate on a
 * publicly-reachable URL is exactly the kind of change someone needs to be able
 * to account for later.
 */
export const setPreviewProtection = mutation
    .use(rateLimit("sensitive"))
    .input({
        id: v.id("projects"),
        organizationId: v.id("organizations"),
        /** The new password, or `null` to remove protection. */
        password: v.union(v.null(), boundedString(LIMITS.token)),
    })
    .mutation(async ({ ctx: context, args: { id, organizationId, password } }): Promise<{ protected: boolean }> => {
        const member = await assertMember(context, organizationId, ["owner", "admin"]);

        await assertRowInOrg(context, id, organizationId, "project");

        if (password === null) {
            await context.db.patch(id, { previewPasswordHash: null, previewPasswordSalt: null });
            await context.db.insert("auditLog", {
                action: "project.preview_protection.disable",
                actorUserId: member.userId,
                createdAt: context.now,
                organizationId,
            });

            return { protected: false };
        }

        if (password.trim().length < MIN_PREVIEW_PASSWORD_LENGTH) {
            throw new LunoraError("BAD_REQUEST", `preview password must be at least ${String(MIN_PREVIEW_PASSWORD_LENGTH)} characters`);
        }

        // A per-project salt, so two projects that pick the same password do not
        // share a hash — and a leaked table cannot be attacked once for all of them.
        const salt = randomSecret();

        await context.db.patch(id, { previewPasswordHash: await sha256Hex(`${salt}:${password}`), previewPasswordSalt: salt });
        await context.db.insert("auditLog", {
            action: "project.preview_protection.enable",
            actorUserId: member.userId,
            createdAt: context.now,
            organizationId,
        });

        return { protected: true };
    });

/**
 * Verify a submitted preview password for one script. SYSTEM only — the
 * dispatcher reaches it through the bearer-gated `POST /v1/tenants/preview-auth`.
 *
 * The hash never leaves the control plane: the dispatcher forwards the submitted
 * password, gets back a yes or no, and mints its own signed cookie from that. So
 * a compromised dispatcher isolate cannot walk away with anything it could
 * attack offline.
 *
 * Attempts are throttled at the edge route instead of here (the `previewAuth`
 * bucket, keyed on the END USER's forwarded IP). A `rateLimit` middleware on this
 * query would key on its caller — the dispatcher — putting every user of every
 * protected preview into one shared bucket, which both fails to isolate an
 * attacker and lets one throttle everybody.
 *
 * Returns `false` for an unknown script or an unprotected project rather than
 * distinguishing them — a caller learning "this preview exists but is not
 * protected" from a failed password attempt is a small leak with no upside.
 */
export const verifyPreviewPassword = internalQuery
    .input({ password: boundedString(LIMITS.token), scriptName: boundedString(LIMITS.name) })
    .query(async ({ ctx: context, args: { password, scriptName } }): Promise<{ ok: boolean }> => {
        const { page } = await context.db.deployments.findMany({ where: { scriptName } });
        const deployment = page[0];

        if (!deployment?.projectId) {
            return { ok: false };
        }

        const project = (await context.db.get(deployment.projectId)) as null | ProjectRow;

        if (!project?.previewPasswordHash || !project.previewPasswordSalt) {
            return { ok: false };
        }

        const presented = await sha256Hex(`${project.previewPasswordSalt}:${password}`);

        return { ok: constantTimeEqual(presented, project.previewPasswordHash) };
    });
