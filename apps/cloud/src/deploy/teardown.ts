/**
 * Resource teardown sweep (GAPS.md A1). The lifecycle crons
 * (`cleanupExpiredPreviews`, `pruneSuperseded`, `organizations.purgeDeleted`)
 * only transition deployments to `destroyed`; the Cloudflare and R2 work happens
 * here, off that status.
 *
 * A release owns no script — each alias has one Worker, updated in place — so a
 * row's own teardown is deleting its stored bundle. The Worker and the project's
 * resources go only once the alias has no deployment left that is not
 * `destroyed`: the project (or preview) itself is gone. `failed` rows are swept
 * too, for their bundle only: a failed release is never a rollback target.
 *
 * Pure over injected ports (like `fanOutCron`). Per-target failure isolation —
 * one Cloudflare or R2 error leaves that row pending for the next tick and never
 * aborts the sweep. Never throws.
 */

import type { DestroyRef } from "../provision";

/** A destroyed or failed deployment whose stored release has not been reclaimed. */
export interface TeardownTarget {
    /** The project's stable label — names its Worker and its project stack. */
    alias: string;

    /**
     * Whether to destroy the alias's Worker and project stack (D1, R2, KV,
     * queues …). True for exactly one pending row of an alias that has no
     * deployment left that is not `destroyed`, so a routine prune never touches
     * the Worker the live release runs on.
     */
    destroyWorker: boolean;
    /** Dispatch namespace the Worker lives in (`lunora-{kind}`). */
    dispatchNamespace: string;
    /** Deployment row id — its stored release key, stamped `teardownAt` once reclaimed. */
    id: string;
}

export interface TeardownPorts {
    /** Delete a deployment's stored release. Idempotent. */
    deleteRelease: (id: string) => Promise<void>;
    /** Destroy the alias's Worker and project resources — `Provisioner.destroy`. */
    destroy: (reference: DestroyRef) => Promise<void>;
    /** The destroyed/failed deployments whose release has not been reclaimed yet. */
    listPending: () => Promise<TeardownTarget[]>;
    /** Record that a deployment's stored release (and, for {@link TeardownTarget.destroyWorker}, its Worker) is gone. */
    markTornDown: (id: string) => Promise<void>;
    /** Release the alias's ownership row once its Worker is gone. Idempotent. */
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
                // eslint-disable-next-line no-await-in-loop -- sequential teardown paces Cloudflare API work; volumes are small
                await ports.destroy({ alias: target.alias, dispatchNamespace: target.dispatchNamespace });

                // The alias is only free once its Worker and resources are gone.
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
            // A Cloudflare/R2 failure (or a transient markTornDown error) leaves the
            // row pending — `teardownAt` stays unset, so the next sweep retries.
            failed += 1;
        }
    }

    return { failed, tornDown };
};
