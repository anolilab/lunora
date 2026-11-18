/**
 * The decisions behind tenant data backups, kept free of I/O so the studio's
 * mutations (`lunora/tenant-backups.ts`) and the scheduled sweep
 * (`./tenant-sweep.ts`) make them the same way: where a snapshot lives, whether a
 * project is busy, whether it is due, and which snapshots retention drops.
 *
 * See `docs/RESTORE.md` for what a snapshot contains and what restoring one does.
 */
import { LUNORA_CLOUD_PLANS } from "../billing/plans";

/** What a `tenantBackups` row records: a snapshot taken, or a snapshot restored. */
export type TenantBackupOperation = "backup" | "restore";

/** Why a backup was taken. `pre-restore` is the automatic snapshot a restore takes first. */
export type TenantBackupTrigger = "manual" | "pre-restore" | "scheduled";

export type TenantBackupStatus = "failed" | "running" | "succeeded";

/** The fields of a `tenantBackups` row these decisions read. */
export interface TenantBackupRecord {
    _id: string;
    createdAt: number;
    /** Last sign of life from the request running the operation; D1 answers SQL NULL for one never written. */
    heartbeatAt?: null | number;
    key?: string;
    operation: TenantBackupOperation;
    projectId: string;
    status: TenantBackupStatus;
}

const HOUR_MS = 60 * 60 * 1000;

/** A scheduled backup is due once the newest successful one is this old. */
export const BACKUP_INTERVAL_MS = 24 * HOUR_MS;

/** After a failed attempt, wait this long before the sweep tries that project again. */
export const BACKUP_RETRY_MS = 6 * HOUR_MS;

/**
 * A `running` row with no sign of life for this long is treated as dead — the
 * request or sweep that owned it was killed mid-flight — so it no longer blocks
 * the project and the sweep marks it failed. A live operation proves itself with
 * {@link HEARTBEAT_INTERVAL_MS} heartbeats, so this bounds how long a dead one
 * blocks, not how long a live one may run.
 */
export const OPERATION_STALE_MS = 30 * 60 * 1000;

/** How often a running operation records that it is still alive: well inside {@link OPERATION_STALE_MS}. */
export const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Whether a row is an operation still in flight: `running`, and created or heard from
 * within {@link OPERATION_STALE_MS}. Age alone is not death — a restore of a large
 * snapshot can run past it while it keeps writing to the tenant.
 */
export const isInFlight = (row: TenantBackupRecord, now: number): boolean =>
    row.status === "running" && Math.max(row.createdAt, row.heartbeatAt ?? 0) > now - OPERATION_STALE_MS;

/**
 * A heartbeat to call on every sign of progress: it runs `write` once
 * {@link HEARTBEAT_INTERVAL_MS} has passed since the last one (or since it was
 * made), so progress in small steps costs one write per interval. A failed
 * write is not the operation's failure; the next beat tries again.
 */
export const throttledHeartbeat = (write: () => Promise<unknown>, clock: () => number = Date.now): (() => Promise<void>) => {
    let last = clock();

    return async () => {
        const now = clock();

        if (now - last < HEARTBEAT_INTERVAL_MS) {
            return;
        }

        last = now;
        await write().catch(() => undefined);
    };
};

/** Failed attempts and restore records are dropped once this old; they hold no data. */
export const RECORD_RETENTION_MS = 30 * 24 * HOUR_MS;

/** Successful snapshots kept per project when the plan names no retention. */
const DEFAULT_RETENTION = 3;

/**
 * `tenant-backups/{organizationId}/{alias}/{timestamp}-{uuid}.ndjson.gz`.
 *
 * ISO-8601 with the punctuation stripped (milliseconds kept), so the keys under
 * one alias sort in the order the snapshots were taken. The random suffix follows
 * the timestamp because a manual or pre-restore backup can land in the same
 * millisecond as the sweep's: sharing one object, pruning either row would delete
 * the other's data.
 */
export const tenantBackupKey = (organizationId: string, alias: string, now: number): string =>
    `tenant-backups/${organizationId}/${alias}/${new Date(now).toISOString().replaceAll(/[.:-]/gu, "")}-${crypto.randomUUID()}.ndjson.gz`;

/** How many successful snapshots a plan keeps per project (plan catalog `limits.backupRetention`). */
export const backupRetentionFor = (plan: string | undefined): number =>
    LUNORA_CLOUD_PLANS.plans[plan ?? "free"]?.limits?.["backupRetention"] ?? LUNORA_CLOUD_PLANS.plans["free"]?.limits?.["backupRetention"] ?? DEFAULT_RETENTION;

/** The project's in-flight backup or restore, if any (see {@link isInFlight}). */
export const activeOperation = <T extends TenantBackupRecord>(rows: ReadonlyArray<T>, projectId: string, now: number): T | undefined =>
    rows.find((row) => row.projectId === projectId && isInFlight(row, now));

/**
 * Whether the sweep should take a scheduled snapshot of this project now: nothing
 * in flight, no successful snapshot within {@link BACKUP_INTERVAL_MS}, and no
 * failed attempt within {@link BACKUP_RETRY_MS} (so a tenant whose export keeps
 * failing is retried a few times a day, not every tick).
 */
export const isDueForBackup = (rows: ReadonlyArray<TenantBackupRecord>, projectId: string, now: number): boolean => {
    const own = rows.filter((row) => row.projectId === projectId && row.operation === "backup");

    if (activeOperation(rows, projectId, now) !== undefined) {
        return false;
    }

    const recentSuccess = own.some((row) => row.status === "succeeded" && row.createdAt > now - BACKUP_INTERVAL_MS);
    const recentFailure = own.some((row) => row.status === "failed" && row.createdAt > now - BACKUP_RETRY_MS);

    return !recentSuccess && !recentFailure;
};

/** Newest successful snapshot time for a project, or 0 — the sweep serves the most overdue first. */
export const lastSuccessAt = (rows: ReadonlyArray<TenantBackupRecord>, projectId: string): number =>
    Math.max(0, ...rows.filter((row) => row.projectId === projectId && row.operation === "backup" && row.status === "succeeded").map((row) => row.createdAt));

/** A project's successful snapshots beyond the newest `keep`, oldest last. */
export const snapshotsPastRetention = <T extends TenantBackupRecord>(rows: ReadonlyArray<T>, projectId: string, keep: number): T[] =>
    rows
        .filter((row) => row.projectId === projectId && row.operation === "backup" && row.status === "succeeded")
        .toSorted((a, b) => b.createdAt - a.createdAt)
        .slice(Math.max(0, keep));
