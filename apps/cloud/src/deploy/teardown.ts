/**
 * Resource teardown sweep (CLOUD-PLAN.md §2.3 / GAPS.md A1). The lifecycle
 * crons (`cleanupExpiredPreviews`, `pruneSuperseded`, `organizations.purgeDeleted`)
 * only transition a deployment to `destroyed`; the actual Cloudflare dispatch
 * script is deleted here, off that status. Without this, dispatch namespaces
 * grow unboundedly — the exact leak GAPS.md Ring-2 flagged.
 *
 * Pure over injected ports (like `fanOutCron`): `listPending` reads the
 * destroyed-but-not-torn-down rows, `destroy` removes the script through the
 * Cloudflare provisioner, and `markTornDown` stamps `teardownAt`. Per-target
 * failure isolation — one Cloudflare error leaves that row pending for the next
 * tick and never aborts the sweep. Never throws.
 */

/** A destroyed deployment whose Cloudflare dispatch script is still live. */
export interface TeardownTarget {
    /** Dispatch namespace the script lives in (`lunora-{kind}`). */
    dispatchNamespace: string;
    /** Deployment row id, stamped `teardownAt` once the script is gone. */
    id: string;
    /** Versioned dispatch-namespace script id to delete. */
    scriptName: string;
}

export interface TeardownPorts {
    /** Delete the dispatch script (the provisioner's `destroy`; 404-tolerant). */
    destroy: (reference: { dispatchNamespace: string; scriptName: string }) => Promise<void>;
    /** The destroyed deployments whose script has not yet been torn down. */
    listPending: () => Promise<TeardownTarget[]>;
    /** Record that a deployment's Cloudflare resources are gone (stamps `teardownAt`). */
    markTornDown: (id: string) => Promise<void>;
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
            await ports.destroy({ dispatchNamespace: target.dispatchNamespace, scriptName: target.scriptName });
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
