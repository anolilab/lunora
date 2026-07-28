import { LunoraError } from "@lunora/server";

import { highestPlan } from "../src/billing/plans";
import { previewExpiry } from "../src/deploy/preview";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx as MutationContext } from "./_generated/server.js";
import { internalMutation, mutation, query, v } from "./_generated/server.js";
import { assertMember, authorizeDeployKey } from "./authz";
import { orgEntitlements } from "./entitlements";
import { rateLimit } from "./guards";
import { boundedString, LIMITS } from "./validators";

type DeploymentStatus = "building" | "destroyed" | "failed" | "live" | "provisioning" | "queued" | "superseded" | "verifying";

interface DeploymentRow {
    _id: Id<"deployments">;
    adminToken?: string;
    adminTokenCiphertext?: string;
    adminTokenIv?: string;
    alias?: string;
    branch?: string;
    bundleHash?: string;
    createdAt: number;
    createdBy: string;
    expiresAt?: number;
    kind: "dev" | "preview" | "production";
    organizationId: Id<"organizations">;
    projectId: Id<"projects">;
    scriptName: string;
    status: DeploymentStatus;
    updatedAt: number;
    url?: string;
    version?: number;
}

interface ProjectRow {
    _id: Id<"projects">;
    activeDeploymentId?: Id<"deployments">;
    activeScriptName?: string;
}

interface AliasOwnershipRow {
    _id: Id<"aliasOwnership">;
    alias: string;
    organizationId: Id<"organizations">;
    projectId: Id<"projects">;
}

/**
 * Claim a deployment alias for a project through the `aliasOwnership` ledger.
 * The ledger's `by_alias` unique index makes the claim atomic, so this closes
 * the check-then-insert TOCTOU in {@link create}: a concurrent first claim of
 * the same new alias by a *different* project loses on the unique constraint and
 * is rejected. Idempotent for the owning project (re-deploys reuse their alias).
 */
export const claimAlias = async (context: MutationContext, alias: string, organizationId: Id<"organizations">, projectId: Id<"projects">): Promise<void> => {
    const currentOwner = async (): Promise<AliasOwnershipRow | undefined> => {
        const { page } = await context.db.aliasOwnership.findMany({ where: { alias } });

        return (page as unknown as AliasOwnershipRow[])[0];
    };

    const existing = await currentOwner();

    if (existing) {
        if (existing.projectId !== projectId) {
            throw new LunoraError("FORBIDDEN", "deployment alias is already in use by another project");
        }

        return;
    }

    try {
        await context.db.insert("aliasOwnership", { alias, createdAt: context.now, organizationId, projectId });
    } catch (error) {
        // Lost a concurrent first-claim race — the `by_alias` unique index rejected
        // the insert. Re-read the winner: if it is us, the claim stands; if it is
        // another project, reject cleanly; otherwise the failure was not an
        // ownership collision, so surface it.
        const winner = await currentOwner();

        if (winner?.projectId === projectId) {
            return;
        }

        if (winner) {
            throw new LunoraError("FORBIDDEN", "deployment alias is already in use by another project");
        }

        throw error;
    }
};

/** The `${status}At` timestamp column stamped on each phase transition (GAPS.md A2). */
const PHASE_TIMESTAMP: Record<DeploymentStatus, "destroyedAt" | "failedAt" | "liveAt" | "provisioningAt" | "queuedAt" | "supersededAt" | "verifyingAt" | null> =
    {
        building: null,
        destroyed: "destroyedAt",
        failed: "failedAt",
        live: "liveAt",
        provisioning: "provisioningAt",
        queued: "queuedAt",
        superseded: "supersededAt",
        verifying: "verifyingAt",
    };

/**
 * Resolve a deployment's tenant URL + *sealed* admin token for the hosted-studio
 * admin proxy (§3). Asserts the caller is a member of the deployment's org.
 * Returns the stored admin-token fields (ciphertext + IV, or the plaintext dev
 * fallback) — the caller decrypts at the edge with `SECRET_ENCRYPTION_KEY`, so
 * the plaintext bearer never crosses the RPC boundary when sealed. Returns
 * `null` when the deployment is missing, in another org, has no admin token, or
 * is not yet live.
 */
export const adminTarget = query
    .input({ deploymentId: v.id("deployments"), organizationId: v.id("organizations") })
    .query(
        async ({
            ctx: context,
            args: { deploymentId, organizationId },
        }): Promise<null | { adminToken?: string; adminTokenCiphertext?: string; adminTokenIv?: string; url: string }> => {
            await assertMember(context, organizationId);

            const deployment = (await context.db.get(deploymentId)) as DeploymentRow | null;
            const hasToken = deployment?.adminToken || (deployment?.adminTokenCiphertext && deployment.adminTokenIv);

            if (deployment?.organizationId !== organizationId || !hasToken || !deployment.url) {
                return null;
            }

            return {
                ...(deployment.adminToken ? { adminToken: deployment.adminToken } : {}),
                ...(deployment.adminTokenCiphertext && deployment.adminTokenIv
                    ? { adminTokenCiphertext: deployment.adminTokenCiphertext, adminTokenIv: deployment.adminTokenIv }
                    : {}),
                url: deployment.url,
            };
        },
    );

/**
 * Resolve a dispatch-namespace script id to its org's plan name, for the
 * dispatcher's per-plan runtime limits (§4). Public + unauthenticated by design
 * (returns only a non-sensitive plan tier); the dispatcher reaches it through a
 * bearer-gated control-plane endpoint. Unknown scripts resolve to `free`.
 */
export const planForScript = query
    .input({ scriptName: boundedString(LIMITS.name) })
    .query(async ({ ctx: context, args: { scriptName } }): Promise<{ plan: string }> => {
        const { page } = await context.db.deployments.findMany({ where: { scriptName } });
        const deployment = (page as unknown as DeploymentRow[])[0];

        if (!deployment) {
            return { plan: "free" };
        }

        // A suspended org (spend cap breached / abuse, GAPS.md C1) resolves to the
        // sentinel plan "suspended" — the dispatcher serves 503 for it. Encoded in
        // the plan string so the dispatcher's existing TTL cache carries it.
        const organization = (await context.db.get(deployment.organizationId)) as { suspendedAt?: number } | null;

        if (organization?.suspendedAt != null) {
            return { plan: "suspended" };
        }

        const entitlements = await orgEntitlements(context, deployment.organizationId);

        return { plan: highestPlan(entitlements.plans) };
    });

/** A project's deployments, newest first. Caller must be a member of the org. */
export const listByProject = query
    .input({ organizationId: v.id("organizations"), projectId: v.id("projects") })
    .query(async ({ ctx: context, args: { organizationId, projectId } }): Promise<DeploymentRow[]> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.deployments.findMany({ where: { organizationId, projectId } });

        return (page as unknown as DeploymentRow[]).toSorted((a, b) => b.createdAt - a.createdAt);
    });

/**
 * Record a new deployment in the `queued` state. Authorized either by a member
 * session (dashboard) or a valid `deployKey` (CI; §2.2). The actual provisioning
 * — bundle upload + per-tenant binding creation via the Alchemy provisioner
 * (`src/provision`), paced by the per-cell scheduler (§2.5) — is driven
 * separately and reports progress back through `updateStatus`.
 */
export const create = mutation
    .use(rateLimit("provision"))
    .input({
        // Tenant admin token the platform set on the worker (for the admin proxy).
        // Sealed at the edge before it reaches here: the encrypted fields are the
        // norm; `adminToken` (plaintext) is only the no-master-key dev fallback.
        adminToken: v.optional(boundedString(LIMITS.sealedToken)),
        adminTokenCiphertext: v.optional(boundedString(LIMITS.cipher)),
        adminTokenIv: v.optional(boundedString(LIMITS.id)),
        branch: v.optional(boundedString(LIMITS.gitRef)),
        // The tenant's compiled cron expressions (for the WfP cron fan-out, §2.4).
        cronSpecs: v.optional(v.array(boundedString(LIMITS.name))),
        // CI deploy path: a valid deploy key authorizes in lieu of a member session.
        deployKey: v.optional(boundedString(LIMITS.token)),
        kind: v.union(v.literal("production"), v.literal("preview"), v.literal("dev")),
        organizationId: v.id("organizations"),
        projectId: v.id("projects"),
        // @lunora/runtime version bundled into this release (fleet-upgrade planner input, GAPS.md E4).
        runtimeVersion: v.optional(boundedString(LIMITS.id)),
        scriptName: boundedString(LIMITS.name),
    })
    .mutation(async ({ ctx: context, args: arguments_ }): Promise<{ deploymentId: Id<"deployments">; scriptName: string; version: number }> => {
        let createdBy: string;

        if (arguments_.deployKey) {
            const deployKeyId = await authorizeDeployKey(context, arguments_.organizationId, arguments_.deployKey, arguments_.projectId);

            createdBy = `deploy-key:${deployKeyId}`;
        } else {
            const member = await assertMember(context, arguments_.organizationId, ["owner", "admin", "member"]);

            createdBy = member.userId;
        }

        // Integrity: the project must belong to the same org (no cross-org linkage).
        const { page } = await context.db.projects.findMany({ where: { organizationId: arguments_.organizationId } });

        if (!(page as unknown as ProjectRow[]).some((project) => project._id === arguments_.projectId)) {
            throw new LunoraError("NOT_FOUND", "project not found in this organization");
        }

        // Isolation: the `alias`/`scriptName` label is the seed for this tenant's
        // per-deployment D1/R2 resource names (`${alias}-db`/`${alias}-files`) in the
        // provisioner, and for alias→script routing. It MUST be owned by exactly one
        // project — otherwise a caller holding a valid key for their own project could
        // pass a victim's alias here and bind the victim's database/bucket into their
        // own worker (or hijack the victim's route / overwrite their script). Claim
        // the alias through the `aliasOwnership` ledger, whose `by_alias` unique index
        // makes the claim atomic (closing the check-then-insert race): a concurrent
        // first claim by a different project loses on the unique constraint.
        await claimAlias(context, arguments_.scriptName, arguments_.organizationId, arguments_.projectId);

        // Versioned, immutable release: `{alias}-v{n}` per (project, kind). The
        // stable alias keeps serving the previous version until `activate`
        // swaps the pointer after the health check (GAPS.md A1).
        const { page: existing } = await context.db.deployments.findMany({ where: { projectId: arguments_.projectId } }); // secret-scanner:allow -- domain field name
        const version = 1 + Math.max(0, ...(existing as unknown as DeploymentRow[]).filter((d) => d.kind === arguments_.kind).map((d) => d.version ?? 0));

        const { now } = context;
        const deploymentId = await context.db.insert("deployments", {
            ...(arguments_.adminToken ? { adminToken: arguments_.adminToken } : {}),
            ...(arguments_.adminTokenCiphertext && arguments_.adminTokenIv
                ? { adminTokenCiphertext: arguments_.adminTokenCiphertext, adminTokenIv: arguments_.adminTokenIv }
                : {}),
            alias: arguments_.scriptName,
            branch: arguments_.branch,
            ...(arguments_.cronSpecs && arguments_.cronSpecs.length > 0 ? { cronSpecs: arguments_.cronSpecs } : {}),
            createdAt: now,
            createdBy,
            // Previews are TTL'd; the cleanup cron tears down expired ones (§2.3).
            ...(arguments_.kind === "preview" ? { expiresAt: previewExpiry(now) } : {}),
            kind: arguments_.kind,
            organizationId: arguments_.organizationId,
            projectId: arguments_.projectId, // secret-scanner:allow -- domain field name, not a Cypress projectId
            queuedAt: now,
            ...(arguments_.runtimeVersion === undefined ? {} : { runtimeVersion: arguments_.runtimeVersion }),
            scriptName: `${arguments_.scriptName}-v${String(version)}`,
            status: "queued",
            updatedAt: now,
            version,
        });

        return { deploymentId, scriptName: `${arguments_.scriptName}-v${String(version)}`, version };
    });

/**
 * Point the project's stable URL at a health-checked live deployment (the
 * blue/green pointer swap, GAPS.md A1). Marks every other live deployment of
 * the same (project, kind) `superseded` — retained for rollback. Authorized by
 * the deploy key (CI) or an owner/admin member session.
 */
export const activate = mutation
    .use(rateLimit("machine"))
    .input({
        deployKey: v.optional(boundedString(LIMITS.token)),
        id: v.id("deployments"),
    })
    .mutation(async ({ ctx: context, args: { deployKey, id } }): Promise<void> => {
        const deployment = (await context.db.get(id)) as DeploymentRow | null;

        if (!deployment) {
            throw new LunoraError("NOT_FOUND", "deployment not found");
        }

        await (deployKey
            ? authorizeDeployKey(context, deployment.organizationId, deployKey, deployment.projectId)
            : assertMember(context, deployment.organizationId, ["owner", "admin"]));

        if (deployment.status !== "live" && deployment.status !== "verifying") {
            throw new LunoraError("CONFLICT", `cannot activate a ${deployment.status} deployment`);
        }

        const { now } = context;
        const { page } = await context.db.deployments.findMany({ where: { projectId: deployment.projectId } }); // secret-scanner:allow -- domain field name
        const others = (page as unknown as DeploymentRow[]).filter((d) => d._id !== id && d.kind === deployment.kind && d.status === "live");

        for (const other of others) {
            // eslint-disable-next-line no-await-in-loop -- small batch; sequential keeps the writer simple
            await context.db.patch(other._id, { status: "superseded", supersededAt: now, updatedAt: now });
        }

        await context.db.patch(deployment.projectId, { activeDeploymentId: id, activeScriptName: deployment.scriptName });
    });

/**
 * Roll the project's stable URL back to a retained deployment (GAPS.md A1).
 * The target must be a `superseded` (or still-`live`) release of the same
 * project; it becomes `live` and the pointer swaps to it, while the currently
 * active deployment is marked `superseded`.
 */
export const rollback = mutation
    .use(rateLimit("machine"))
    .input({
        deployKey: v.optional(boundedString(LIMITS.token)),
        id: v.id("deployments"),
        organizationId: v.id("organizations"),
    })
    .mutation(async ({ ctx: context, args: { deployKey, id, organizationId } }): Promise<{ scriptName: string; version?: number }> => {
        const target = (await context.db.get(id)) as DeploymentRow | null;

        if (target?.organizationId !== organizationId) {
            throw new LunoraError("NOT_FOUND", "deployment not found in this organization");
        }

        // Authorize AFTER resolving the target, so a project-scoped deploy key is
        // checked against the target deployment's OWN project — a key scoped to
        // project A must not be able to roll back project B's deployment in the same
        // org (every sibling — create/activate/updateStatus — passes projectId).
        await (deployKey
            ? authorizeDeployKey(context, organizationId, deployKey, target.projectId)
            : assertMember(context, organizationId, ["owner", "admin"]));

        if (target.status !== "superseded" && target.status !== "live") {
            throw new LunoraError("CONFLICT", `cannot roll back to a ${target.status} deployment`);
        }

        const { now } = context;
        const project = (await context.db.get(target.projectId)) as ProjectRow | null;

        if (project?.activeDeploymentId && project.activeDeploymentId !== id) {
            await context.db.patch(project.activeDeploymentId, { status: "superseded", supersededAt: now, updatedAt: now });
        }

        await context.db.patch(id, { liveAt: now, status: "live", updatedAt: now });
        await context.db.patch(target.projectId, { activeDeploymentId: id, activeScriptName: target.scriptName });
        await context.db.insert("auditLog", {
            action: "deployment.rollback",
            actorUserId: deployKey ? "deploy-key" : (context.auth.userId ?? "unknown"),
            createdAt: now,
            organizationId,
            target: target.scriptName,
        });

        return { scriptName: target.scriptName, version: target.version };
    });

/**
 * Resolve a stable alias (the project's public subdomain label) to the active
 * versioned script. Public + unauthenticated like {@link planForScript} (returns
 * only a script id); the dispatcher reaches it through a bearer-gated
 * control-plane endpoint. Falls back to the newest live deployment when the
 * pointer was never set (pre-blue/green rows).
 */
export const routeForAlias = query
    .input({ alias: boundedString(LIMITS.name) })
    .query(async ({ ctx: context, args: { alias } }): Promise<{ scriptName: string } | null> => {
        const { page } = await context.db.deployments.findMany({ where: { alias } });
        const rows = page as unknown as DeploymentRow[];
        const first = rows[0];

        if (!first) {
            return null;
        }

        const project = (await context.db.get(first.projectId)) as ProjectRow | null;

        if (project?.activeScriptName) {
            return { scriptName: project.activeScriptName };
        }

        const live = rows.filter((d) => d.status === "live").toSorted((a, b) => b.createdAt - a.createdAt)[0];

        return live ? { scriptName: live.scriptName } : null;
    });

/** Superseded production releases retained per project for rollback (GAPS.md A1). */
export const SUPERSEDED_RETENTION = 3;

/**
 * Prune old superseded releases beyond the rollback retention window: per
 * (project, kind), keep the newest {@link SUPERSEDED_RETENTION} superseded
 * deployments and mark the rest `destroyed` — the 🌐 teardown path deletes the
 * actual dispatch scripts off that status, so namespaces never accumulate
 * unboundedly. SYSTEM only (cron dispatch).
 */
export const pruneSuperseded = internalMutation.mutation(async ({ ctx: context }): Promise<{ pruned: number }> => {
    const { now } = context;
    // Filter in the QUERY, not after it. `findMany({})` returns one 1000-row page, so
    // filtering afterwards meant live/failed/destroyed rows could fill the page and
    // starve the superseded ones this prune exists to collect.
    const { page } = await context.db.deployments.findMany({ where: { status: "superseded" } });
    const superseded = page as unknown as DeploymentRow[];

    const byProjectKind = new Map<string, DeploymentRow[]>();

    for (const deployment of superseded) {
        const groupKey = `${deployment.projectId}|${deployment.kind}`;
        const group = byProjectKind.get(groupKey) ?? [];

        group.push(deployment);
        byProjectKind.set(groupKey, group);
    }

    let pruned = 0;

    for (const group of byProjectKind.values()) {
        const excess = group.toSorted((a, b) => b.createdAt - a.createdAt).slice(SUPERSEDED_RETENTION);

        for (const deployment of excess) {
            // eslint-disable-next-line no-await-in-loop -- small batch; sequential keeps the writer simple
            await context.db.patch(deployment._id, { destroyedAt: now, status: "destroyed", updatedAt: now });
            pruned += 1;
        }
    }

    return { pruned };
});

/**
 * Mark expired preview deployments as `destroyed` (CLOUD-PLAN.md §2.3). Driven
 * by the cleanup cron (`lunora/crons.ts`); `internalMutation` so it is reachable
 * only via the cron's system dispatch, never from a client. The actual
 * Cloudflare teardown is the provisioner's `destroy` (orchestrator) — wired once
 * Alchemy lands; this records the lifecycle transition.
 */
export const cleanupExpiredPreviews = internalMutation.mutation(async ({ ctx: context }): Promise<{ destroyed: number }> => {
    const { now } = context;
    const { page } = await context.db.deployments.findMany({ where: { kind: "preview" } });

    const expired = (page as unknown as DeploymentRow[]).filter(
        (deployment) => deployment.status !== "destroyed" && deployment.expiresAt != null && deployment.expiresAt < now,
    );

    for (const deployment of expired) {
        // eslint-disable-next-line no-await-in-loop -- small batch; sequential keeps the writer simple
        await context.db.patch(deployment._id, { status: "destroyed", updatedAt: now });
    }

    return { destroyed: expired.length };
});

/**
 * Advance a deployment's lifecycle (queued → provisioning → building → live, or
 * → failed). Driven by the deploy orchestrator as it works through the
 * provisioner's progress events, authorized by the same `deployKey` (CI) or a
 * member session (dashboard).
 *
 * Kept a public `mutation` deliberately: the deploy endpoint reaches it through
 * the HTTP action context's `ctx.runMutation`, whose dispatch carries no
 * system-dispatch flag — so an `internalMutation` would be unreachable from that
 * seam (it would 404 at the RPC visibility gate). Authorization is enforced
 * here instead (deploy key or org membership).
 */
export const updateStatus = mutation
    .use(rateLimit("machine"))
    .input({
        bundleHash: v.optional(boundedString(LIMITS.name)),
        deployKey: v.optional(boundedString(LIMITS.token)),
        id: v.id("deployments"),
        status: v.union(
            v.literal("queued"),
            v.literal("provisioning"),
            v.literal("building"),
            v.literal("verifying"),
            v.literal("live"),
            v.literal("superseded"),
            v.literal("failed"),
            v.literal("destroyed"),
        ),
        url: v.optional(boundedString(LIMITS.url)),
    })
    .mutation(async ({ ctx: context, args: { bundleHash, deployKey, id, status, url } }): Promise<void> => {
        const existing = (await context.db.get(id)) as DeploymentRow | null;

        if (!existing) {
            throw new LunoraError("NOT_FOUND", "deployment not found");
        }

        await (deployKey
            ? authorizeDeployKey(context, existing.organizationId, deployKey, existing.projectId)
            : assertMember(context, existing.organizationId, ["owner", "admin", "member"]));

        const { now } = context;
        const phaseColumn = PHASE_TIMESTAMP[status];

        await context.db.patch(id, {
            ...(bundleHash === undefined ? {} : { bundleHash }),
            ...(url === undefined ? {} : { url }),
            ...(phaseColumn ? { [phaseColumn]: now } : {}),
            status,
            updatedAt: now,
        });
    });
