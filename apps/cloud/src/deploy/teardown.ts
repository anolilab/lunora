/**
 * Resource teardown sweep (GAPS.md A1). The lifecycle crons
 * (`cleanupExpiredPreviews`, `pruneSuperseded`, `organizations.purgeDeleted`)
 * only transition deployments to `destroyed`; the target and R2 work happens
 * here, off that status.
 *
 * A release owns no tenant — each alias has one, updated in place — so a row's
 * own teardown is deleting its stored bundle. The tenant and the project's
 * resources go only once the alias has no deployment left that is not
 * `destroyed`: the project (or preview) itself is gone, and the row's target
 * driver destroys them. `failed` rows are swept
 * too, for their bundle only: a failed release is never a rollback target.
 *
 * Pure over injected ports (like `fanOutCron`). Per-row failure isolation — one
 * driver or R2 error leaves that row pending for the next tick and never aborts
 * the sweep. Never throws.
 */

import type { TargetId } from "../provision-contract";

/** A destroyed or failed deployment whose stored release has not been reclaimed. */
export interface TeardownTarget {
    /** The project's stable label — names its tenant and its per-project resources. */
    alias: string;
    /** The box the alias runs on (`celld-vps`), from its deployment rows — the project may be gone. */
    boxId?: string;
    /** The connected Cloudflare account the alias runs in (`cloudflare-workers`), from its deployment rows. */
    cloudflareAccountId?: string;

    /**
     * Whether to destroy the alias's tenant and its resources (D1, R2, KV,
     * queues …). True for exactly one pending row of an alias that has no
     * deployment left that is not `destroyed`, so a routine prune never touches
     * the tenant the live release runs on.
     */
    destroyWorker: boolean;
    /** Deployment row id — its stored release key, stamped `teardownAt` once reclaimed. */
    id: string;
    /** The target the row was deployed to — whose driver destroys it. */
    target: TargetId;
}

export interface TeardownPorts {
    /** Delete a deployment's stored release. Idempotent. */
    deleteRelease: (id: string) => Promise<void>;
    /** Destroy the alias's tenant and its resources — through the driver of the placement its rows name. */
    destroy: (target: TeardownTarget) => Promise<void>;
    /** The destroyed/failed deployments whose release has not been reclaimed yet. */
    listPending: () => Promise<TeardownTarget[]>;
    /** Record that a deployment's stored release (and, for {@link TeardownTarget.destroyWorker}, its tenant) is gone. */
    markTornDown: (id: string) => Promise<void>;
    /** Release the alias's ownership row once its tenant is gone. Idempotent. */
    releaseAlias: (alias: string) => Promise<void>;
}

export interface TeardownResult {
    /** Targets whose delete threw — left pending, retried next tick. */
    failed: number;
    /** Targets reclaimed and marked torn down. */
    tornDown: number;
}

/**
 * Reclaim every pending target, then mark the row. Idempotent (driven off
 * `listPending`, which excludes already-torn-down rows) and failure-isolated per
 * target.
 */
export const runTeardownSweep = async (ports: TeardownPorts): Promise<TeardownResult> => {
    const targets = await ports.listPending();
    let tornDown = 0;
    let failed = 0;

    for (const target of targets) {
        try {
            if (target.destroyWorker) {
                // eslint-disable-next-line no-await-in-loop -- sequential teardown paces the target's API work; volumes are small
                await ports.destroy(target);

                // The alias is only free once its tenant and resources are gone.
                // Released BEFORE `markTornDown` so a failure here leaves the row
                // pending and the (idempotent) release retries next tick.
                // eslint-disable-next-line no-await-in-loop -- sequential; volumes are small
                await ports.releaseAlias(target.alias);
            }

            // eslint-disable-next-line no-await-in-loop -- sequential; volumes are small
            await ports.deleteRelease(target.id);
            // eslint-disable-next-line no-await-in-loop -- must mark before moving on so a mid-sweep crash doesn't redo the work
            await ports.markTornDown(target.id);
            tornDown += 1;
        } catch {
            // A driver/R2 failure (or a transient markTornDown error) leaves the
            // row pending — `teardownAt` stays unset, so the next sweep retries.
            failed += 1;
        }
    }

    return { failed, tornDown };
};
