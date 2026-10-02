import { LunoraError } from "@lunora/server";

import { highestPlan } from "../src/billing/plans";
import { previewExpiry } from "../src/deploy/preview";
import { DEFAULT_TARGET, isBoxTarget, storedTarget } from "../src/provision-contract";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx as MutationContext, QueryCtx as QueryContext } from "./_generated/server.js";
import { internalMutation, internalQuery, mutation, query, v } from "./_generated/server.js";
import { fireDeployAlerts } from "./alerts";
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
    bindings?: { name: string; target?: string; type: string }[];
    branch?: string;
    bundleHash?: string;
    createdAt: number;
    createdBy: string;
    cronSpecs?: null | string[];
    expiresAt?: number;
    kind: "dev" | "preview" | "production";
    organizationId: Id<"organizations">;
    projectId: Id<"projects">;
    scriptName: string;
    status: DeploymentStatus;
    target?: string;
    updatedAt: number;
    url?: string;
    version?: number;
}

/** The live deployment of one alias + kind — the release currently on that alias's Worker. */
const liveRelease = async (context: QueryContext, row: Pick<DeploymentRow, "alias" | "kind" | "projectId">): Promise<DeploymentRow | undefined> => {
    const { page } = await context.db.deployments.findMany({ where: { projectId: row.projectId } }); // secret-scanner:allow -- domain field name

    return page.filter((d) => d.alias === row.alias && d.kind === row.kind && d.status === "live").toSorted((a, b) => b.createdAt - a.createdAt)[0];
};

/**
 * Move a project's pointer to a deployment. Production only: the pointer answers
 * "which release serves this project's own domain", and a preview carries an
 * alias of its own — letting it move the pointer pointed custom domains at a
 * preview.
 */
const pointProjectAt = async (context: MutationContext, deployment: DeploymentRow): Promise<void> => {
    if (deployment.kind === "production") {
        await context.db.patch(deployment.projectId, { activeDeploymentId: deployment._id, activeScriptName: deployment.scriptName });
    }
};

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

        return page[0];
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
            // Not bare `assertMember`. This resolves the tenant's ADMIN bearer for
            // the studio proxy, which forwards writes to the tenant's own admin
            // API — so a `viewer`, whose whole role is read-only, was able to
            // mutate tenant data through it. Roles are named explicitly here
            // rather than at the route, because the token is handed out here.
            await assertMember(context, organizationId, ["owner", "admin", "member"]);

            const deployment = (await context.db.get(deploymentId)) as DeploymentRow | null;
            const hasToken = deployment?.adminToken ?? (deployment?.adminTokenCiphertext && deployment.adminTokenIv);

            // Live only: every release of an alias shares one Worker, and only the
            // release on it holds the admin token that Worker accepts.
            if (deployment?.organizationId !== organizationId || deployment.status !== "live" || !hasToken || !deployment.url) {
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

/** Whether a project has a preview password set. Read as part of {@link planForScript}. */
const previewProtectionEnabled = async (context: QueryContext, projectId: Id<"projects">): Promise<boolean> => {
    const project = (await context.db.get(projectId)) as null | { previewPasswordHash?: string };

    return Boolean(project?.previewPasswordHash);
};

/**
 * Resolve a dispatch-namespace script id to its org's plan name, for the
 * dispatcher's per-plan runtime limits (§4). Public + unauthenticated by design
 * (returns only a non-sensitive plan tier); the dispatcher reaches it through a
 * bearer-gated control-plane endpoint. Unknown scripts resolve to `free`.
 */
export const planForScript = query
    .input({ scriptName: boundedString(LIMITS.name) })
    .query(async ({ ctx: context, args: { scriptName } }): Promise<{ plan: string; protected?: boolean }> => {
        const { page } = await context.db.deployments.findMany({ where: { scriptName } });
        const deployment = page[0];

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

        // Deployment protection rides along on the plan lookup rather than getting
        // its own endpoint: this is the dispatcher's ONE cached control-plane call
        // on the request path, and a second resolver would double that traffic to
        // answer a question the same row already knows. Only the boolean crosses —
        // the password hash stays in the control plane (`verifyPreviewPassword`).
        //
        // Protection applies to PREVIEW deployments only. Production is public by
        // definition, and gating it here would be a foot-gun with no undo.
        const isProtectedPreview = deployment.kind === "preview" && (await previewProtectionEnabled(context, deployment.projectId));

        return { plan: highestPlan(entitlements.plans), ...(isProtectedPreview ? { protected: true } : {}) };
    });

/** A project's deployments, newest first. Caller must be a member of the org. */

/**
 * A deployment as the dashboard sees it — the stored row minus its admin token.
 *
 * The projection is the whole point. `deployments` stores the tenant admin bearer
 * (sealed as `adminTokenCiphertext`/`adminTokenIv`, and in plaintext on a
 * deployment with no master key configured), and this query is authorized for any
 * org MEMBER. Returning the row verbatim — which it did — handed every member a
 * credential that proxies into that tenant's `/_lunora/admin/*` API. Nothing
 * failed and nothing logged it: the `Promise&lt;DeploymentRow[]>` annotation is
 * compile-time only and strips nothing at the wire.
 */
type DeploymentView = Omit<DeploymentRow, "adminToken" | "adminTokenCiphertext" | "adminTokenIv">;

/** Drop the admin-token fields from a stored row. */
export const toDeploymentView = (row: DeploymentRow): DeploymentView => {
    // Built by naming what is KEPT rather than destructuring away what is dropped:
    // a rest-spread would silently carry any future column, which is precisely how
    // the admin token reached the wire in the first place.
    return {
        _id: row._id,
        createdAt: row.createdAt,
        createdBy: row.createdBy,
        kind: row.kind,
        organizationId: row.organizationId,
        projectId: row.projectId,
        scriptName: row.scriptName,
        status: row.status,
        updatedAt: row.updatedAt,
        ...(row.alias === undefined ? {} : { alias: row.alias }),
        ...(row.bindings === undefined ? {} : { bindings: row.bindings }),
        ...(row.branch === undefined ? {} : { branch: row.branch }),
        ...(row.bundleHash === undefined ? {} : { bundleHash: row.bundleHash }),
        ...(row.expiresAt === undefined ? {} : { expiresAt: row.expiresAt }),
        ...(row.url === undefined ? {} : { url: row.url }),
        ...(row.version === undefined ? {} : { version: row.version }),
    };
};

export const listByProject = query
    .input({ organizationId: v.id("organizations"), projectId: v.id("projects") })
    .query(async ({ ctx: context, args: { organizationId, projectId } }): Promise<DeploymentView[]> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.deployments.findMany({ where: { organizationId, projectId } });

        return page.map((row) => toDeploymentView(row)).toSorted((a, b) => b.createdAt - a.createdAt);
    });

/** What {@link create} answers: the new row, its release number, and the release live on the alias before it (the revert target). */
interface CreatedDeployment {
    deploymentId: Id<"deployments">;
    previousDeploymentId?: Id<"deployments">;
    version: number;
}

/**
 * Record a new deployment in the `queued` state. Authorized either by a member
 * session (dashboard) or a valid `deployKey` (CI; §2.2). The actual provisioning
 * — bundle upload + per-tenant binding creation through the project's target
 * driver (`src/targets/`), paced by the per-cell scheduler (§2.5) — is driven
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
        // What the tenant's wrangler config binds, captured at deploy time — the
        // studio renders this as the deployment's binding graph.
        bindings: v.optional(
            v.array(v.object({ name: boundedString(LIMITS.name), target: v.optional(boundedString(LIMITS.name)), type: boundedString(LIMITS.tag) })),
        ),
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
    .mutation(async ({ ctx: context, args: arguments_ }): Promise<CreatedDeployment> => {
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
        const project = page.find((row) => row._id === arguments_.projectId);

        if (!project) {
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

        // One Worker per alias: the script name IS the alias, and every release
        // updates it in place so its Durable Object data persists. `version`
        // numbers releases per (project, kind) for history and rollback; the
        // release itself is the payload the deploy handler stores under this id.
        const { page: existing } = await context.db.deployments.findMany({ where: { projectId: arguments_.projectId } }); // secret-scanner:allow -- domain field name
        const version = 1 + Math.max(0, ...existing.filter((d) => d.kind === arguments_.kind).map((d) => d.version ?? 0));
        const previous = await liveRelease(context, { alias: arguments_.scriptName, kind: arguments_.kind, projectId: arguments_.projectId }); // secret-scanner:allow -- domain field name

        const { now } = context;
        // A row predating targets answers NULL, which is the default target.
        const target = storedTarget(project.target) ?? DEFAULT_TARGET;
        const deploymentId = await context.db.insert("deployments", {
            ...(arguments_.adminToken ? { adminToken: arguments_.adminToken } : {}),
            ...(arguments_.adminTokenCiphertext && arguments_.adminTokenIv
                ? { adminTokenCiphertext: arguments_.adminTokenCiphertext, adminTokenIv: arguments_.adminTokenIv }
                : {}),
            alias: arguments_.scriptName,
            // The box a `celld-vps` release runs on — what its teardown reaches
            // once the project (and with it the placement) is gone.
            ...(isBoxTarget(target) && project.boxId != null ? { boxId: project.boxId } : {}),
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
            ...(arguments_.bindings === undefined ? {} : { bindings: arguments_.bindings }),
            // Every target names its tenant by the alias today; a driver whose
            // handle differs would report its own here.
            resourceRef: arguments_.scriptName,
            ...(arguments_.runtimeVersion === undefined ? {} : { runtimeVersion: arguments_.runtimeVersion }),
            scriptName: arguments_.scriptName,
            status: "queued",
            // Copied from the project, which owns it: the release is converged
            // there, and its teardown and rollback must follow it there even if
            // the project's target later changes.
            target,
            updatedAt: now,
            version,
        });

        return { deploymentId, ...(previous ? { previousDeploymentId: previous._id } : {}), version };
    });

/**
 * Record a health-checked deployment as its alias's live release (GAPS.md A1).
 * The Worker already runs it — this is bookkeeping, not a cutover. Marks every
 * other live deployment of the same alias + kind `superseded`: their stored
 * bundles are the rollback targets. Authorized by the deploy key (CI) or an
 * owner/admin member session.
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
        const others = page.filter((d) => d._id !== id && d.alias === deployment.alias && d.kind === deployment.kind && d.status === "live");

        for (const other of others) {
            // eslint-disable-next-line no-await-in-loop -- small batch; sequential keeps the writer simple
            await context.db.patch(other._id, { status: "superseded", supersededAt: now, updatedAt: now });
        }

        await pointProjectAt(context, deployment);
        // `activate` is the CI path — the most frequent pointer swap on the
        // platform — and it was the only one of the five that wrote no audit row.
        // "Who moved this project's stable URL, and when" was answerable for a
        // manual rollback or a promoted canary and unanswerable for an ordinary
        // release, which is the case incident forensics actually asks about.
        await context.db.insert("auditLog", {
            action: "deployment.activate",
            actorUserId: deployKey ? "deploy-key" : (context.auth.userId ?? "unknown"),
            createdAt: now,
            organizationId: deployment.organizationId,
            target: deployment.scriptName,
        });
    });

/**
 * Record a completed rollback (GAPS.md A1). The deploy edge calls this only
 * AFTER it has re-provisioned the target's stored bundle onto the alias's
 * Worker (`src/deploy/release.ts`) — calling it alone would claim a release the
 * Worker is not running, so it is an `internalMutation`: only the deploy edge's
 * rollback routes (`POST /v1/deployments/rollback`, `POST /v1/rollback`) reach it,
 * after the re-provision. The caller is still authorized here (deploy key or
 * owner/admin session) — an internal function is only as scoped as its caller.
 * The target must be a `superseded` (or still-`live`) release; it becomes `live`
 * and the release it replaced is `superseded`.
 */
export const rollback = internalMutation
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
        const replaced = await liveRelease(context, target);

        if (replaced && replaced._id !== id) {
            await context.db.patch(replaced._id, { status: "superseded", supersededAt: now, updatedAt: now });
        }

        await context.db.patch(id, { liveAt: now, status: "live", updatedAt: now });
        await pointProjectAt(context, target);
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
 * What the deploy edge needs to re-provision a stored release onto its alias's
 * Worker (rollback, or the automatic revert after a failed health check): the
 * deployment's *sealed* admin token — unsealed at the edge, never here — its
 * identity, and the release currently live on that Worker. Authorized like
 * {@link rollback}: the deploy key against the deployment's own project, or an
 * owner/admin session. Only `live`/`superseded` deployments are releases a
 * Worker can be put back on. An `internalQuery` because it hands out admin-token
 * material: only the deploy edge may read it, never RPC.
 */
export const releaseTarget = internalQuery
    .input({ deployKey: v.optional(boundedString(LIMITS.token)), id: v.id("deployments"), organizationId: v.id("organizations") })
    .query(
        async ({
            ctx: context,
            args: { deployKey, id, organizationId },
        }): Promise<{
            adminToken?: string;
            adminTokenCiphertext?: string;
            adminTokenIv?: string;
            alias: string;
            cronSpecs?: string[];
            kind: DeploymentRow["kind"];
            liveDeploymentId?: Id<"deployments">;
            projectId: Id<"projects">;
            target?: string;
        }> => {
            const target = (await context.db.get(id)) as DeploymentRow | null;

            if (target?.organizationId !== organizationId) {
                throw new LunoraError("NOT_FOUND", "deployment not found in this organization");
            }

            await (deployKey
                ? authorizeDeployKey(context, organizationId, deployKey, target.projectId)
                : assertMember(context, organizationId, ["owner", "admin"]));

            if (target.status !== "superseded" && target.status !== "live") {
                throw new LunoraError("CONFLICT", `cannot re-provision a ${target.status} deployment`);
            }

            const live = await liveRelease(context, target);

            return {
                ...(target.adminToken ? { adminToken: target.adminToken } : {}),
                ...(target.adminTokenCiphertext && target.adminTokenIv
                    ? { adminTokenCiphertext: target.adminTokenCiphertext, adminTokenIv: target.adminTokenIv }
                    : {}),
                alias: target.alias ?? target.scriptName,
                ...(target.cronSpecs != null && target.cronSpecs.length > 0 ? { cronSpecs: target.cronSpecs } : {}),
                kind: target.kind,
                ...(live ? { liveDeploymentId: live._id } : {}),
                projectId: target.projectId, // secret-scanner:allow -- domain field name
                ...(target.target == null ? {} : { target: target.target }),
            };
        },
    );

/** Superseded releases retained per alias for rollback (GAPS.md A1). */
export const SUPERSEDED_RETENTION = 3;

/**
 * Prune old superseded releases beyond the rollback retention window: per
 * alias + kind, keep the newest {@link SUPERSEDED_RETENTION} superseded
 * deployments and mark the rest `destroyed`. A release owns no script — the
 * alias's one Worker is shared — so the teardown sweep only deletes a pruned
 * row's stored bundle. The live release is never superseded, so never pruned.
 * SYSTEM only (cron dispatch).
 */
export const pruneSuperseded = internalMutation.mutation(async ({ ctx: context }): Promise<{ pruned: number }> => {
    const { now } = context;
    // Filter in the QUERY, not after it. `findMany({})` returns one 1000-row page, so
    // filtering afterwards meant live/failed/destroyed rows could fill the page and
    // starve the superseded ones this prune exists to collect.
    const { page: superseded } = await context.db.deployments.findMany({ where: { status: "superseded" } });

    const byProjectKind = new Map<string, DeploymentRow[]>();

    for (const deployment of superseded) {
        const groupKey = `${deployment.alias ?? deployment.scriptName}|${deployment.kind}`;
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
 * Mark expired preview deployments as `destroyed`. Driven
 * by the cleanup cron (`lunora/crons.ts`); `internalMutation` so it is reachable
 * only via the cron's system dispatch, never from a client. The actual
 * Cloudflare teardown is the provisioner's `destroy` (orchestrator) — wired once
 * Alchemy lands; this records the lifecycle transition.
 */
export const cleanupExpiredPreviews = internalMutation.mutation(async ({ ctx: context }): Promise<{ destroyed: number }> => {
    const { now } = context;
    const { page } = await context.db.deployments.findMany({ where: { kind: "preview" } });

    const expired = page.filter((deployment) => deployment.status !== "destroyed" && deployment.expiresAt != null && deployment.expiresAt < now);

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

        // Notify the org's `deploy` rules, but only on the transition INTO failed.
        // The orchestrator re-drives this mutation as it works through the
        // provisioner's events, and a deployment that is already failed can be
        // written again by a retry — firing on the state rather than the crossing
        // would page somebody once per attempt for one broken release.
        if (status === "failed" && existing.status !== "failed") {
            const project = (await context.db.get(existing.projectId)) as null | { name: string };

            await fireDeployAlerts(context, existing.organizationId, `deployment:${id}`, {
                detail: `The deployment did not reach a live state. Its last recorded phase was "${existing.status}".`,
                kind: "deployment",
                project: project?.name ?? "project",
                reference: existing.scriptName,
            });
        }
    });

/**
 * Resolve everything `lunora cloud eject` needs to package a deployment: the
 * tenant URL, its *sealed* admin token, and the identity the scaffolded config
 * is named after.
 *
 * An `internalQuery` rather than a widening of {@link adminTarget}: that one is
 * session-authorized for the hosted studio's browser proxy, while eject arrives
 * over a deploy key from a terminal.
 *
 * **The key is authorized HERE, not at the edge.** An earlier cut resolved the
 * org from the key with `orgForDeployKey` — the helper the OTLP endpoints use,
 * which deliberately accepts ANY non-revoked key and checks neither capability
 * nor project scope. That made a full tenant data export reachable from a
 * telemetry `ingest` token: the lowest-privilege credential on the platform, and
 * one the platform itself injects into every tenant Worker as an env secret. So
 * `authorizeDeployKey` runs inside this query, against the deployment's own org
 * and project, exactly as {@link rollback} does — a route cannot forget to do
 * what it does not perform.
 *
 * The admin token is returned sealed. The edge decrypts it with
 * `SECRET_ENCRYPTION_KEY` exactly as the studio proxy does, so the plaintext
 * bearer never crosses the RPC boundary. SYSTEM only.
 */
export const ejectTarget = internalQuery.input({ deployKey: boundedString(LIMITS.token), deploymentId: v.id("deployments") }).query(
    async ({
        ctx: context,
        args: { deployKey, deploymentId },
    }): Promise<null | {
        adminToken?: string;
        adminTokenCiphertext?: string;
        adminTokenIv?: string;
        organizationId: Id<"organizations">;
        projectSlug: string;
        scriptName: string;
        url: string;
    }> => {
        const deployment = (await context.db.get(deploymentId)) as DeploymentRow | null;

        if (!deployment) {
            return null;
        }

        // Throws for a revoked key, a telemetry-only ingest key, or a key scoped to
        // another project — the tenant boundary, enforced before anything about the
        // deployment is read out.
        await authorizeDeployKey(context, deployment.organizationId, deployKey, deployment.projectId);

        const hasToken = deployment.adminToken ?? (deployment.adminTokenCiphertext && deployment.adminTokenIv);

        // Live only, as in `adminTarget`: the alias's one Worker accepts only the
        // admin token of the release it is running.
        if (deployment.status !== "live" || !hasToken || !deployment.url) {
            return null;
        }

        const project = (await context.db.get(deployment.projectId)) as { slug?: string } | null;

        return {
            ...(deployment.adminToken ? { adminToken: deployment.adminToken } : {}),
            ...(deployment.adminTokenCiphertext && deployment.adminTokenIv
                ? { adminTokenCiphertext: deployment.adminTokenCiphertext, adminTokenIv: deployment.adminTokenIv }
                : {}),
            organizationId: deployment.organizationId,
            projectSlug: project?.slug ?? deployment.scriptName,
            scriptName: deployment.scriptName,
            url: deployment.url,
        };
    },
);
