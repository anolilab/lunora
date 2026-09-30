/**
 * Resource teardown sweep (GAPS.md A1). The lifecycle
 * crons (`cleanupExpiredPreviews`, `pruneSuperseded`, `organizations.purgeDeleted`)
 * only transition a deployment to `destroyed`; the actual Cloudflare dispatch
 * script is deleted here, off that status. Without this, dispatch namespaces
 * grow unboundedly — the exact leak GAPS.md Ring-2 flagged.
 *
 * Pure over injected ports (like `fanOutCron`): `listPending` reads the
 * destroyed-but-not-torn-down rows, `destroy` sends the provisioner's destroy
 * job to the provision box, and `markTornDown` stamps `teardownAt`. Per-target
 * failure isolation — one Cloudflare error leaves that row pending for the next
 * tick and never aborts the sweep. Never throws.
 */

import type { DestroyRef } from "../provision";

/** A destroyed deployment whose Cloudflare dispatch script is still live. */
export interface TeardownTarget {
    /** The project's stable label — keys the project stack whose resources {@link deleteResources} removes. */
    alias: string;

    /**
     * Whether to also destroy the project stack (D1, R2, KV, queues …). True
     * only when this is the *last* remaining deployment of its alias (no live/superseded sibling), so a
     * routine version prune never destroys the database the active version uses.
     */
    deleteResources: boolean;
    /** Dispatch namespace the script lives in (`lunora-{kind}`). */
    dispatchNamespace: string;
    /** Deployment row id, stamped `teardownAt` once the script is gone. */
    id: string;
    /** Versioned dispatch-namespace script id to delete. */
    scriptName: string;
}

export interface TeardownPorts {
    /** Destroy the release (+ the project's resources when {@link DestroyRef.deleteResources}) — `Provisioner.destroy`. */
    destroy: (reference: DestroyRef) => Promise<void>;
    /** The destroyed deployments whose script has not yet been torn down. */
    listPending: () => Promise<TeardownTarget[]>;
    /** Record that a deployment's Cloudflare resources are gone (stamps `teardownAt`). */
    markTornDown: (id: string) => Promise<void>;
    /** Release the alias's ownership row once its last deployment is gone. Idempotent. */
    releaseAlias: (alias: string) => Promise<void>;
}

export interface TeardownResult {
    /** Targets whose Cloudflare delete threw — left pending, retried next tick. */
    failed: number;
    /** Targets whose script was deleted and row marked torn down. */
    tornDown: number;
}

/**
 * Tear down every destroyed-but-not-torn-down deployment's Cloudflare dispatch
 * script, then mark the row. Idempotent (driven off `listPending`, which
 * excludes already-torn-down rows) and failure-isolated per target.
 */
export const runTeardownSweep = async (ports: TeardownPorts): Promise<TeardownResult> => {
    const targets = await ports.listPending();
    let tornDown = 0;
    let failed = 0;

    for (const target of targets) {
        try {
            // eslint-disable-next-line no-await-in-loop -- sequential teardown paces Cloudflare API work; volumes are small
            await ports.destroy({
                alias: target.alias,
                deleteResources: target.deleteResources,
                dispatchNamespace: target.dispatchNamespace,
                scriptName: target.scriptName,
            });

            // The alias is only free once its last deployment's resources are gone
            // (`deleteResources`) — release its ownership row so the label can be
            // re-claimed. Released BEFORE `markTornDown` so a failure here leaves the
            // row pending and the (idempotent) release retries next tick; a routine
            // version prune (deleteResources=false) never touches ownership.
            if (target.deleteResources) {
                // eslint-disable-next-line no-await-in-loop -- sequential; volumes are small
                await ports.releaseAlias(target.alias);
            }

            // eslint-disable-next-line no-await-in-loop -- must mark before moving on so a mid-sweep crash doesn't re-delete
            await ports.markTornDown(target.id);
            tornDown += 1;
        } catch {
            // A Cloudflare failure (or a transient markTornDown error) leaves the
            // row pending — `teardownAt` stays unset, so the next sweep retries.
            failed += 1;
        }
    }

    return { failed, tornDown };
};
