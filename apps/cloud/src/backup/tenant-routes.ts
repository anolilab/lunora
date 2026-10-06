/**
 * The studio's tenant backup routes (docs/RESTORE.md), mounted by the deploy
 * router under the caller's member session:
 *
 * - `POST /v1/backups` — "Back up now".
 * - `POST /v1/backups/restore` — restore a snapshot, after an automatic
 *   pre-restore snapshot of the current data.
 * - `POST /v1/backups/download` — stream one snapshot to the caller.
 *
 * Authorization lives in the `internal.tenant_backups.*` mutations each route
 * calls first (owner/admin, the project's own org, not while busy). They return
 * the deployment's admin token SEALED; it is unsealed here, at the edge, and goes
 * no further than the `authorization` header of the tenant call — exactly as the
 * studio admin proxy and rollback handle it.
 */
import { internal } from "../../lunora/_generated/api.js";
import type { StoredAdminToken } from "../deploy/admin-token";
import { resolveAdminToken } from "../deploy/admin-token";
import type { RouterEnv } from "../deploy/routes/shared";
import { jsonError, rejected, requireContext } from "../deploy/routes/shared";
import { targetOf } from "../targets/placement";
import { targetFleet } from "../targets/registry";
import { offsiteBucket } from "./offsite";
import { offsiteFields } from "./tenant-sweep";
import type { RestoreSummary, TenantBackupBucket, TenantSend } from "./tenant-transport";
import { captureTenantSnapshot, restoreTenantSnapshot } from "./tenant-transport";

/** The deployment a begin* mutation resolved, admin token still sealed. */
type TenantTarget = StoredAdminToken & { alias: string; resourceRef: string; scriptName: string; target?: string; url: string };

type Context = ReturnType<typeof requireContext>;

const MAX_ERROR_LENGTH = 500;

const describe = (error: unknown, fallback: string): string => (error instanceof Error ? error.message : fallback).slice(0, MAX_ERROR_LENGTH);

const readBody = async <T>(request: Request): Promise<Partial<T> | null> => (await request.json().catch(() => null)) as Partial<T> | null;

/** Unseal the target's admin token and reach it through its driver, or throw when it has none usable. */
const senderFor = async (target: TenantTarget, environment: RouterEnv): Promise<TenantSend> => {
    const adminToken = await resolveAdminToken(target, environment.SECRET_ENCRYPTION_KEY);

    if (!adminToken) {
        throw new Error("deployment has no usable admin token");
    }

    return targetFleet(targetOf(target.target), environment).reach({ adminToken, resourceRef: target.resourceRef, url: target.url });
};

/**
 * Settle a row the router started. A settle that fails (the caller's role was
 * revoked mid-flight, say) leaves the row `running` until the sweep reaps it —
 * the tenant-side outcome is already decided, so the response still reports it.
 */
const settle = async (
    context: Context,
    organizationId: string,
    id: string,
    outcome: Record<string, number | Record<string, number> | string>,
): Promise<void> => {
    await context.runMutation(internal.tenant_backups.finish, { id, organizationId, ...outcome }).catch(() => undefined);
};

/**
 * Take one snapshot into `key` (and the off-site copy, when configured) and
 * settle its row. A failed off-site copy is recorded on the row, not raised.
 * Resolves to the stored size, or rejects with the failure (already recorded).
 */
const snapshot = async (
    context: Context,
    environment: RouterEnv & { TENANT_BACKUPS: TenantBackupBucket },
    organizationId: string,
    row: { id: string; key: string; target: TenantTarget },
): Promise<number> => {
    try {
        const offsite = offsiteBucket(environment);
        const { bytes, offsite: copied } = await captureTenantSnapshot({
            bucket: environment.TENANT_BACKUPS,
            key: row.key,
            ...(offsite ? { offsite } : {}),
            send: await senderFor(row.target, environment),
        });

        await settle(context, organizationId, row.id, { bytes, status: "succeeded", ...offsiteFields(copied) });

        return bytes;
    } catch (error) {
        await settle(context, organizationId, row.id, { error: describe(error, "backup failed"), status: "failed" });

        throw error;
    }
};

/** Narrow the env to one with the bucket, or answer 500. */
const withBucket = (environment: RouterEnv): (RouterEnv & { TENANT_BACKUPS: TenantBackupBucket }) | Response =>
    environment.TENANT_BACKUPS
        ? (environment as RouterEnv & { TENANT_BACKUPS: TenantBackupBucket })
        : jsonError(500, "the TENANT_BACKUPS bucket is not configured on this cell");

/** `POST /v1/backups` — snapshot a project's production data now. */
export const handleBackupNowRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);
    const env = withBucket(environment);

    if (env instanceof Response) {
        return env;
    }

    const body = await readBody<{ organizationId: string; projectId: string }>(request);

    if (!body?.organizationId || !body.projectId) {
        return jsonError(400, "organizationId and projectId are required");
    }

    let started: TenantTarget & { backupId: string; key: string };

    try {
        started = await context.runMutation(internal.tenant_backups.beginBackup, { organizationId: body.organizationId, projectId: body.projectId });
    } catch (error) {
        return rejected(error, "backup refused");
    }

    try {
        const bytes = await snapshot(context, env, body.organizationId, { id: started.backupId, key: started.key, target: started });

        return Response.json({ backupId: started.backupId, bytes, ok: true });
    } catch (error) {
        return jsonError(502, describe(error, "backup failed"));
    }
};

/**
 * `POST /v1/backups/restore` — restore one snapshot into the project's live
 * production Worker.
 *
 * Takes a snapshot of the current data FIRST and refuses to touch anything if
 * that fails. Then rewinds the tenant to the chosen snapshot through its staged
 * replace import — every batch staged, then one commit: rows deleted since come
 * back, rows edited since get their snapshot contents, rows created since are
 * removed. A failure while staging aborts, leaving the tenant untouched.
 * Restoring the pre-restore snapshot the same way undoes it.
 */
export const handleRestoreRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);
    const env = withBucket(environment);

    if (env instanceof Response) {
        return env;
    }

    const body = await readBody<{ backupId: string; organizationId: string }>(request);

    if (!body?.organizationId || !body.backupId) {
        return jsonError(400, "organizationId and backupId are required");
    }

    const { organizationId } = body;
    let started: TenantTarget & { preRestoreBackupId: string; preRestoreKey: string; restoreId: string; sourceKey: string };

    try {
        started = await context.runMutation(internal.tenant_backups.beginRestore, { backupId: body.backupId, organizationId });
    } catch (error) {
        return rejected(error, "restore refused");
    }

    try {
        await snapshot(context, env, organizationId, { id: started.preRestoreBackupId, key: started.preRestoreKey, target: started });
    } catch (error) {
        const reason = `pre-restore backup failed, nothing was restored: ${describe(error, "backup failed")}`;

        await settle(context, organizationId, started.restoreId, { error: reason.slice(0, MAX_ERROR_LENGTH), status: "failed" });

        return jsonError(502, reason);
    }

    let summary: RestoreSummary;

    try {
        const source = await env.TENANT_BACKUPS.get(started.sourceKey);

        if (!source) {
            throw new Error("the snapshot object is missing from the backup bucket");
        }

        summary = await restoreTenantSnapshot(await senderFor(started, env), source.body);
    } catch (error) {
        const reason = describe(error, "restore failed");

        await settle(context, organizationId, started.restoreId, { error: reason, status: "failed" });

        return jsonError(502, reason);
    }

    await settle(context, organizationId, started.restoreId, {
        restoreDeleted: summary.deletedByTable,
        restoreInserted: summary.inserted,
        status: "succeeded",
    });

    return Response.json({ ok: true, preRestoreBackupId: started.preRestoreBackupId, restoreId: started.restoreId, summary });
};

/** `POST /v1/backups/download` — stream one snapshot (gzipped NDJSON) to an owner/admin. */
export const handleDownloadRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);
    const env = withBucket(environment);

    if (env instanceof Response) {
        return env;
    }

    const body = await readBody<{ backupId: string; organizationId: string }>(request);

    if (!body?.organizationId || !body.backupId) {
        return jsonError(400, "organizationId and backupId are required");
    }

    let authorized: { alias: string; createdAt: number; key: string };

    try {
        authorized = await context.runMutation(internal.tenant_backups.authorizeDownload, { backupId: body.backupId, organizationId: body.organizationId });
    } catch (error) {
        return rejected(error, "download refused");
    }

    const object = await env.TENANT_BACKUPS.get(authorized.key);

    if (!object) {
        return jsonError(404, "the snapshot object is missing from the backup bucket");
    }

    const stamp = new Date(authorized.createdAt).toISOString().replaceAll(/[.:-]/gu, "");
    const filename = `${authorized.alias.replaceAll(/[^\w-]/gu, "-")}-${stamp}.ndjson.gz`;

    return new Response(object.body, {
        headers: {
            "cache-control": "no-store",
            "content-disposition": `attachment; filename="${filename}"`,
            "content-length": String(object.size),
            "content-type": "application/gzip",
        },
    });
};
