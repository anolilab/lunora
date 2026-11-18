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

    /**
     * Whether to destroy the alias's tenant and its resources (D1, R2, KV,
     * queues …). True for exactly one pending row of an alias that has no
     * deployment left that is not `destroyed`, so a routine prune never touches
     * the tenant the live release runs on.
     */
    destroyWorker: boolean;
    /** Deployment row id — its stored release key, stamped `teardownAt` once reclaimed. */
    id: string;
    /** The host the alias runs on (a box, a connected account), from its deployment rows — the project may be gone. */
    placementRef?: string;
    /** The project the row was released for — the only owner whose claim on the alias its teardown may release. */
    projectId: string;
    /** The target the row was deployed to — whose driver destroys it. */
    target: TargetId;
}

export interface TeardownPorts {
    /**
     * Whether the alias has a deployment that is not `destroyed`, read now. The
     * sweep re-asks right before each destructive step: `listPending` elects off
     * a snapshot, and a release created for the alias since must keep its tenant
     * and its claim on the alias.
     */
    aliasInUse: (alias: string) => Promise<boolean>;
    /** Delete a deployment's stored release. Idempotent. */
    deleteRelease: (id: string) => Promise<void>;
    /** Destroy the alias's tenant and its resources — through the driver of the placement its rows name. */
    destroy: (target: TeardownTarget) => Promise<void>;

    /**
     * Mark `projectId`'s claim on the alias as being torn down (true, nothing
     * written, when no claim is left). `deployments.create` refuses a release for an
     * alias so marked, after inserting its row: with the sweep writing the mark
     * before it asks {@link aliasInUse}, one of the two always sees the other.
     * False, and nothing written, when another project owns the alias: its
     * tenant is that project's now.
     */
    holdAlias: (alias: string, projectId: string) => Promise<boolean>;

    /** The destroyed/failed deployments whose release has not been reclaimed yet. */
    listPending: () => Promise<TeardownTarget[]>;
    /** Record that a deployment's stored release (and, for {@link TeardownTarget.destroyWorker}, its tenant) is gone. */
    markTornDown: (id: string) => Promise<void>;

    /**
     * Release `projectId`'s claim on the alias once its tenant is gone — never
     * another project's: one that claimed the alias since holds its own reservation.
     * Idempotent.
     */
    releaseAlias: (alias: string, projectId: string) => Promise<void>;
    /** Clear {@link holdAlias}'s mark when the tenant was kept, so a release can be created again. Idempotent. */
    unholdAlias: (alias: string, projectId: string) => Promise<void>;
}

export interface TeardownResult {
    /** Targets whose delete threw — left pending, retried next tick. */
    failed: number;
    /** Targets reclaimed and marked torn down. */
    tornDown: number;
}

/**
 * Destroy the alias's tenant and release the claim, unless a release holds it.
 *
 * The hold is written before the alias is checked, and held through the
 * destroy: a release created after the check is refused by
 * `deployments.create`, which inserts its row before reading the hold. The
 * hold is cleared whenever the tenant is kept, a failed destroy included, so
 * it never blocks a release beyond the run that set it.
 */
const destroyTenant = async (ports: TeardownPorts, target: TeardownTarget): Promise<void> => {
    if (!(await ports.holdAlias(target.alias, target.projectId))) {
        return;
    }

    let released = false;

    try {
        if (await ports.aliasInUse(target.alias)) {
            return;
        }

        await ports.destroy(target);

        // The alias is only free once its tenant and resources are gone.
        // Released BEFORE `markTornDown` so a failure here leaves the row
        // pending and the (idempotent) release retries next tick. Asked again:
        // a release that read the hold as stale still owns the claim.
        if (!(await ports.aliasInUse(target.alias))) {
            await ports.releaseAlias(target.alias, target.projectId);
            released = true;
        }
    } finally {
        if (!released) {
            await ports.unholdAlias(target.alias, target.projectId);
        }
    }
};

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
                await destroyTenant(ports, target);
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
