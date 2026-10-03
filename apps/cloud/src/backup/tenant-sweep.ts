/**
 * Scheduled tenant data backups (docs/RESTORE.md).
 *
 * `./sweep.ts` backs up the control plane's own D1; this backs up the tenants.
 * Each hourly tick it snapshots the projects whose production data is due (no
 * successful snapshot in the last day), through the same admin export `lunora
 * cloud eject` reads, into the private `TENANT_BACKUPS` bucket — then applies
 * each plan's retention and removes the snapshots of deleted projects.
 *
 * Expressed over injected ports like the other sweeps (`../deploy/sweeps.ts`,
 * `../uptime/sweep.ts`), so the selection, isolation and retention are testable
 * against a fake store and bucket. `src/server.ts` supplies the real D1, R2 and
 * each deployment's target driver.
 *
 * One tenant never takes the sweep down: every snapshot runs in its own
 * try/catch and lands as a `failed` row with a bounded reason. Snapshots run one
 * at a time — each is assembled in memory (`MAX_SNAPSHOT_BYTES`), so running them
 * concurrently multiplies the peak rather than the throughput.
 */
import type { ControlPlaneDatabase } from "../store";
import { drainTable } from "../store";
import type { TenantBackupRecord } from "./tenant-policy";
import {
    backupRetentionFor,
    isDueForBackup,
    lastSuccessAt,
    OPERATION_STALE_MS,
    RECORD_RETENTION_MS,
    snapshotsPastRetention,
    tenantBackupKey,
} from "./tenant-policy";
import type { TenantBackupBucket, TenantSend } from "./tenant-transport";
import { captureTenantSnapshot } from "./tenant-transport";

/** A live production deployment the sweep can snapshot. */
export interface BackupTargetRow {
    _id: string;
    adminToken?: string;
    adminTokenCiphertext?: string;
    adminTokenIv?: string;
    alias?: string;
    createdAt: number;
    kind: string;
    organizationId: string;
    projectId: string;
    /** The deployment's handle on its target; absent on rows that predate it (the script name serves). */
    resourceRef?: string;
    scriptName: string;
    status: string;
    /** Absent on rows that predate targets (`cloudflare-wfp`). */
    target?: string;
    url?: string;
}

interface StoredBackupRow extends TenantBackupRecord {
    organizationId: string;
}

export interface TenantBackupSweepDeps {
    bucket: TenantBackupBucket;
    database: ControlPlaneDatabase;
    /** Operational log line. Receives ids and counts only — never a token or snapshot bytes. */
    log?: (line: string) => void;
    now: number;
    /** Reach one deployment's admin API (the token unsealed in-process), or `null` when it has no usable token. */
    senderFor: (deployment: BackupTargetRow) => Promise<null | TenantSend>;
}

export interface TenantBackupSweepResult {
    failed: number;
    /** Objects + rows removed by retention and deleted-project cleanup. */
    pruned: number;
    /** Stale `running` rows marked failed. */
    reaped: number;
    succeeded: number;
}

/**
 * Snapshots per tick. Hourly ticks at this bound cover ~480 projects a day; a
 * larger fleet needs a higher bound or more cells. Each snapshot is two
 * subrequests plus two D1 writes, far inside one invocation's budget.
 */
export const MAX_BACKUPS_PER_TICK = 20;

/** Retention deletions per tick, so a backlog (a plan downgrade, a mass project delete) drains over ticks. */
export const MAX_PRUNES_PER_TICK = 200;

const MAX_ERROR_LENGTH = 500;

const describe = (error: unknown): string => (error instanceof Error ? error.message : "backup failed").slice(0, MAX_ERROR_LENGTH);

/** Mark `running` rows whose owner died (request killed, isolate evicted) as failed, so they stop blocking their project. */
const reapStale = async (database: ControlPlaneDatabase, rows: StoredBackupRow[], now: number): Promise<number> => {
    const stale = rows.filter((row) => row.status === "running" && row.createdAt <= now - OPERATION_STALE_MS);

    for (const row of stale) {
        // eslint-disable-next-line no-await-in-loop -- a handful of rows at most; sequential keeps the writer simple
        await database.patch(row._id, { completedAt: now, error: "interrupted before it finished", status: "failed" }, "tenantBackups");
        row.status = "failed";
    }

    return stale.length;
};

/** Take one scheduled snapshot, recording its outcome. Never throws. */
const snapshotOne = async (deps: TenantBackupSweepDeps, deployment: BackupTargetRow & { alias: string }): Promise<boolean> => {
    const { bucket, database, now } = deps;
    const key = tenantBackupKey(deployment.organizationId, deployment.alias, now);
    const id = String(
        await database.insert("tenantBackups", {
            alias: deployment.alias,
            createdAt: now,
            deploymentId: deployment._id,
            key,
            operation: "backup",
            organizationId: deployment.organizationId,
            projectId: deployment.projectId, // secret-scanner:allow -- domain field name
            status: "running",
            trigger: "scheduled",
        }),
    );

    try {
        const send = await deps.senderFor(deployment);

        if (!send) {
            throw new Error("deployment has no usable admin token");
        }

        const bytes = await captureTenantSnapshot({ bucket, key, send });

        await database.patch(id, { bytes, completedAt: Date.now(), status: "succeeded" }, "tenantBackups");

        return true;
    } catch (error) {
        const reason = describe(error);

        deps.log?.(`[tenant-backup] ${deployment.alias} failed: ${reason}`);
        await database.patch(id, { completedAt: Date.now(), error: reason, status: "failed" }, "tenantBackups").catch(() => undefined);

        return false;
    }
};

/**
 * Apply retention and cleanup. Deletes the R2 object before its row, so a crash
 * between the two leaves a row pointing at nothing (retried next tick) rather
 * than an object no row can find.
 */
const prune = async (
    deps: TenantBackupSweepDeps,
    rows: StoredBackupRow[],
    liveProjects: Set<string>,
    planByOrg: Map<string, string | undefined>,
): Promise<number> => {
    const { bucket, database, now } = deps;
    const doomed = new Map<string, StoredBackupRow>();

    for (const row of rows) {
        // A deleted project (or purged org — the purge deletes its projects) takes
        // its snapshots with it: a backup must not outlive a right-to-erasure request.
        const orphaned = !liveProjects.has(row.projectId);
        // Failed attempts and restore records hold no data of their own; keep them a month for the UI.
        const expiredRecord = (row.status === "failed" || row.operation === "restore") && row.createdAt < now - RECORD_RETENTION_MS;

        if ((orphaned && row.status !== "running") || expiredRecord) {
            doomed.set(row._id, row);
        }
    }

    for (const projectId of new Set(rows.map((row) => row.projectId))) {
        const organizationId = rows.find((row) => row.projectId === projectId)?.organizationId ?? "";

        for (const row of snapshotsPastRetention(rows, projectId, backupRetentionFor(planByOrg.get(organizationId)))) {
            doomed.set(row._id, row);
        }
    }

    let pruned = 0;

    for (const row of [...doomed.values()].slice(0, MAX_PRUNES_PER_TICK)) {
        try {
            if (row.operation === "backup" && row.key) {
                // eslint-disable-next-line no-await-in-loop -- bounded by MAX_PRUNES_PER_TICK; sequential keeps object-before-row ordering per row
                await bucket.delete(row.key);
            }

            // eslint-disable-next-line no-await-in-loop -- see above
            await database.delete(row._id, "tenantBackups");
            pruned += 1;
        } catch (error) {
            deps.log?.(`[tenant-backup] prune of ${row._id} failed: ${describe(error)}`);
        }
    }

    return pruned;
};

/** One tick: reap dead operations, snapshot the due projects, apply retention. */
export const runTenantBackupSweep = async (deps: TenantBackupSweepDeps): Promise<TenantBackupSweepResult> => {
    const { database, now } = deps;
    const [rows, deployments, projects, organizations] = await Promise.all([
        drainTable<StoredBackupRow>(database, "tenantBackups"),
        drainTable<BackupTargetRow>(database, "deployments", { where: { status: "live" } }),
        drainTable<{ _id: string }>(database, "projects"),
        drainTable<{ _id: string; plan?: string }>(database, "organizations"),
    ]);

    const reaped = await reapStale(database, rows, now);

    // Newest live production release per project — the one on the alias's Worker.
    const targets = new Map<string, BackupTargetRow & { alias: string }>();

    for (const row of deployments) {
        // `!= null`: D1 answers SQL NULL, never `undefined`, for an unset optional column.
        if (row.kind === "production" && row.alias != null && (targets.get(row.projectId)?.createdAt ?? -1) < row.createdAt) {
            targets.set(row.projectId, row as BackupTargetRow & { alias: string });
        }
    }

    const due = [...targets.values()]
        .filter((target) => isDueForBackup(rows, target.projectId, now))
        .toSorted((a, b) => lastSuccessAt(rows, a.projectId) - lastSuccessAt(rows, b.projectId))
        .slice(0, MAX_BACKUPS_PER_TICK);

    let succeeded = 0;

    for (const target of due) {
        // eslint-disable-next-line no-await-in-loop -- one snapshot in memory at a time (see the module note)
        succeeded += (await snapshotOne(deps, target)) ? 1 : 0;
    }

    const pruned = await prune(
        deps,
        rows,
        new Set(projects.map((project) => project._id)),
        new Map(organizations.map((organization) => [organization._id, organization.plan])),
    );

    return { failed: due.length - succeeded, pruned, reaped, succeeded };
};
