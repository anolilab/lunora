import { LunoraError } from "@lunora/server";

import { activeOperation, tenantBackupKey } from "../src/backup/tenant-policy";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx as MutationContext, QueryCtx as QueryContext } from "./_generated/server.js";
import { internalMutation, query, v } from "./_generated/server.js";
import { assertMember } from "./authz";
import { rateLimit } from "./guards";
import { boundedString, LIMITS } from "./validators";

/**
 * Tenant data backups (docs/RESTORE.md). The studio lists snapshots through
 * {@link list}; everything that hands out admin-token material or starts work on
 * a tenant is `internal*` and reached only from the deploy router's
 * `/v1/backups*` routes, which unseal the token at the edge and talk to the
 * tenant — the same split as `deployments.rollback` / `releaseTarget`. Each of
 * those still authorizes its caller (owner/admin), since an internal function is
 * only as scoped as the route that calls it.
 */

type OrgId = Id<"organizations">;
type BackupId = Id<"tenantBackups">;

interface BackupRow {
    _id: BackupId;
    alias: string;
    bytes?: number;
    completedAt?: number;
    createdAt: number;
    deploymentId: Id<"deployments">;
    error?: string;
    key: string;
    operation: "backup" | "restore";
    organizationId: OrgId;
    projectId: Id<"projects">;
    restoreConflicts?: number;
    restoredFrom?: BackupId;
    restoreInserted?: number;
    restoreRowErrors?: number;
    status: "failed" | "running" | "succeeded";
    trigger: "manual" | "pre-restore" | "scheduled";
}

interface DeploymentRow {
    _id: Id<"deployments">;
    adminToken?: string;
    adminTokenCiphertext?: string;
    adminTokenIv?: string;
    alias?: string;
    createdAt: number;
    kind: string;
    resourceRef?: string;
    scriptName: string;
    status: string;
    target?: string;
    url?: string;
}

/** What the router needs to reach a project's production Worker: its identity and the SEALED admin token (unsealed at the edge). */
interface TenantTarget {
    adminToken?: string;
    adminTokenCiphertext?: string;
    adminTokenIv?: string;
    alias: string;
    deploymentId: Id<"deployments">;
    /** The deployment's handle on its target (the script name on rows that predate it). */
    resourceRef: string;
    scriptName: string;
    /** The deployment's target; absent on rows that predate it (`cloudflare-wfp`). */
    target?: string;
    url: string;
}

/** Snapshots listed per project — well past the largest plan's retention, so a list never truncates a kept snapshot. */
const LIST_LIMIT = 100;

/** A row as the studio sees it. The R2 key stays server-side; downloads go through the authorized route. */
type BackupView = Omit<BackupRow, "key">;

/** Named field by field, like `toDeploymentView`: a rest-spread would carry any future column to the wire. */
const toView = (row: BackupRow): BackupView => {
    return {
        _id: row._id,
        alias: row.alias,
        createdAt: row.createdAt,
        deploymentId: row.deploymentId,
        operation: row.operation,
        organizationId: row.organizationId,
        projectId: row.projectId,
        status: row.status,
        trigger: row.trigger,
        ...(row.bytes == null ? {} : { bytes: row.bytes }),
        ...(row.completedAt == null ? {} : { completedAt: row.completedAt }),
        ...(row.error == null ? {} : { error: row.error }),
        ...(row.restoredFrom == null ? {} : { restoredFrom: row.restoredFrom }),
        ...(row.restoreConflicts == null ? {} : { restoreConflicts: row.restoreConflicts }),
        ...(row.restoreInserted == null ? {} : { restoreInserted: row.restoreInserted }),
        ...(row.restoreRowErrors == null ? {} : { restoreRowErrors: row.restoreRowErrors }),
    };
};

const projectRows = async (context: QueryContext, projectId: Id<"projects">): Promise<BackupRow[]> => {
    const { page } = await context.db.tenantBackups.findMany({ where: { projectId } });

    return page;
};

/**
 * The project's live production deployment with a usable admin token, as a
 * router target. Backups are of production data only: a preview runs on its own
 * alias with its own database, which is disposable by design.
 */
const productionTarget = async (context: QueryContext, projectId: Id<"projects">): Promise<TenantTarget> => {
    const { page } = await context.db.deployments.findMany({ where: { projectId } }); // secret-scanner:allow -- domain field name
    const live = (page as DeploymentRow[])
        .filter((row) => row.kind === "production" && row.status === "live" && row.alias != null && row.url != null)
        .toSorted((a, b) => b.createdAt - a.createdAt)[0];
    const hasToken = live?.adminToken ?? (live?.adminTokenCiphertext && live.adminTokenIv);

    if (!live?.alias || !live.url || !hasToken) {
        throw new LunoraError("NOT_FOUND", "this project has no live production deployment to back up or restore");
    }

    return {
        ...(live.adminToken ? { adminToken: live.adminToken } : {}),
        ...(live.adminTokenCiphertext && live.adminTokenIv ? { adminTokenCiphertext: live.adminTokenCiphertext, adminTokenIv: live.adminTokenIv } : {}),
        alias: live.alias,
        deploymentId: live._id,
        resourceRef: live.resourceRef ?? live.scriptName,
        scriptName: live.scriptName,
        ...(live.target == null ? {} : { target: live.target }),
        url: live.url,
    };
};

/** Refuse when the project already has a backup or restore in flight. */
const assertIdle = async (context: QueryContext, projectId: Id<"projects">, now: number): Promise<void> => {
    const busy = activeOperation(await projectRows(context, projectId), projectId, now);

    if (busy) {
        throw new LunoraError("CONFLICT", `a ${busy.operation} of this project is already running — try again when it finishes`);
    }
};

const insertAudit = async (context: MutationContext, organizationId: OrgId, action: string, target: string): Promise<void> => {
    await context.db.insert("auditLog", { action, actorUserId: context.auth.userId ?? "unknown", createdAt: context.now, organizationId, target });
};

/** A project's backups and restores, newest first (members only). */
export const list = query
    .input({ organizationId: v.id("organizations"), projectId: v.id("projects") })
    .query(async ({ ctx: context, args: { organizationId, projectId } }): Promise<BackupView[]> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.tenantBackups.findMany({ where: { organizationId, projectId } });

        return (page as BackupRow[])
            .toSorted((a, b) => b.createdAt - a.createdAt)
            .slice(0, LIST_LIMIT)
            .map((row) => toView(row));
    });

/**
 * Start a manual backup ("Back up now"): record it `running` and hand the router
 * the target to export from and the key to write. Owner/admin only; refused while
 * another backup or restore of the project is running. SYSTEM only (router).
 */
export const beginBackup = internalMutation
    .use(rateLimit("api"))
    .input({ organizationId: v.id("organizations"), projectId: v.id("projects") })
    .mutation(async ({ ctx: context, args: { organizationId, projectId } }): Promise<TenantTarget & { backupId: BackupId; key: string }> => {
        await assertMember(context, organizationId, ["owner", "admin"]);

        const project = (await context.db.get(projectId)) as null | { organizationId: OrgId };

        if (project?.organizationId !== organizationId) {
            throw new LunoraError("NOT_FOUND", "project not found in this organization");
        }

        const target = await productionTarget(context, projectId);

        await assertIdle(context, projectId, context.now);

        const key = tenantBackupKey(organizationId, target.alias, context.now);
        const backupId = await context.db.insert("tenantBackups", {
            alias: target.alias,
            createdAt: context.now,
            deploymentId: target.deploymentId,
            key,
            operation: "backup",
            organizationId,
            projectId,
            status: "running",
            trigger: "manual",
        });

        await insertAudit(context, organizationId, "tenant_backup.create", target.alias);

        return { ...target, backupId, key };
    });

/**
 * Start a restore of one of the project's snapshots. Records the restore and
 * the automatic pre-restore backup the router takes first, both `running`, so
 * nothing else can start on the project until both settle. Owner/admin only.
 * SYSTEM only (router).
 */
export const beginRestore = internalMutation
    .use(rateLimit("api"))
    .input({ backupId: v.id("tenantBackups"), organizationId: v.id("organizations") })
    .mutation(
        async ({
            ctx: context,
            args: { backupId, organizationId },
        }): Promise<TenantTarget & { preRestoreBackupId: BackupId; preRestoreKey: string; restoreId: BackupId; sourceKey: string }> => {
            await assertMember(context, organizationId, ["owner", "admin"]);

            const source = (await context.db.get(backupId)) as BackupRow | null;

            if (source?.organizationId !== organizationId || source.operation !== "backup") {
                throw new LunoraError("NOT_FOUND", "backup not found in this organization");
            }

            if (source.status !== "succeeded") {
                throw new LunoraError("CONFLICT", `cannot restore a ${source.status} backup`);
            }

            const target = await productionTarget(context, source.projectId);

            await assertIdle(context, source.projectId, context.now);

            const common = { alias: target.alias, createdAt: context.now, deploymentId: target.deploymentId, organizationId, projectId: source.projectId }; // secret-scanner:allow -- domain field name
            const preRestoreKey = tenantBackupKey(organizationId, target.alias, context.now);
            const preRestoreBackupId = await context.db.insert("tenantBackups", {
                ...common,
                key: preRestoreKey,
                operation: "backup",
                status: "running",
                trigger: "pre-restore",
            });
            const restoreId = await context.db.insert("tenantBackups", {
                ...common,
                key: source.key,
                operation: "restore",
                restoredFrom: backupId,
                status: "running",
                trigger: "manual",
            });

            await insertAudit(context, organizationId, "tenant_backup.restore", `${target.alias}@${new Date(source.createdAt).toISOString()}`);

            return { ...target, preRestoreBackupId, preRestoreKey, restoreId, sourceKey: source.key };
        },
    );

/**
 * Settle a backup or restore the router started. Owner/admin only, and only a
 * `running` row of the caller's org — a settled row is history and stays as it
 * is. SYSTEM only (router).
 */
export const finish = internalMutation
    .input({
        bytes: v.optional(v.number()),
        error: v.optional(boundedString(LIMITS.url)),
        id: v.id("tenantBackups"),
        organizationId: v.id("organizations"),
        restoreConflicts: v.optional(v.number()),
        restoreInserted: v.optional(v.number()),
        restoreRowErrors: v.optional(v.number()),
        status: v.union(v.literal("succeeded"), v.literal("failed")),
    })
    .mutation(async ({ ctx: context, args: { id, organizationId, ...outcome } }): Promise<null> => {
        await assertMember(context, organizationId, ["owner", "admin"]);

        const row = (await context.db.get(id)) as BackupRow | null;

        if (row?.organizationId !== organizationId) {
            throw new LunoraError("NOT_FOUND", "backup not found in this organization");
        }

        if (row.status !== "running") {
            throw new LunoraError("CONFLICT", `this ${row.operation} already ${row.status}`);
        }

        // Only the keys actually supplied: the store refuses an explicit `undefined`.
        const patch = Object.fromEntries(Object.entries(outcome).filter(([, value]) => value != null));

        await context.db.patch(id, { ...patch, completedAt: context.now });

        return null;
    });

/**
 * Authorize a download of one snapshot and audit it. Owner/admin only — a
 * snapshot is the project's whole dataset. Returns the R2 key the router
 * streams from; the object itself is never public. SYSTEM only (router).
 */
export const authorizeDownload = internalMutation
    .use(rateLimit("api"))
    .input({ backupId: v.id("tenantBackups"), organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { backupId, organizationId } }): Promise<{ alias: string; createdAt: number; key: string }> => {
        await assertMember(context, organizationId, ["owner", "admin"]);

        const row = (await context.db.get(backupId)) as BackupRow | null;

        if (row?.organizationId !== organizationId || row.operation !== "backup" || row.status !== "succeeded") {
            throw new LunoraError("NOT_FOUND", "backup not found in this organization");
        }

        await insertAudit(context, organizationId, "tenant_backup.download", `${row.alias}@${new Date(row.createdAt).toISOString()}`);

        return { alias: row.alias, createdAt: row.createdAt, key: row.key };
    });
