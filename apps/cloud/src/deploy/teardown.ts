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

import type { CloudflareApi } from "../cloudflare/api";
import { tenantD1Name, tenantR2Bucket } from "../provision";

/** A destroyed deployment whose Cloudflare dispatch script is still live. */
export interface TeardownTarget {
    /** The project's stable label — keys the per-project D1/R2 to delete. */
    alias: string;
    /**
     * Whether to also delete the per-project D1/R2. True only when this is the
     * *last* remaining deployment of its alias (no live/superseded sibling), so a
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
    /** Delete the dispatch script (+ per-project D1/R2 when {@link ResourceRef.deleteResources}). */
    destroy: (reference: ResourceRef) => Promise<void>;
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
            await ports.destroy({
                alias: target.alias,
                deleteResources: target.deleteResources,
                dispatchNamespace: target.dispatchNamespace,
                scriptName: target.scriptName,
            });
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

/** Reference to a deployment's Cloudflare resources for teardown. */
export interface ResourceRef {
    /** Project label keying the per-project D1/R2 (only used when {@link deleteResources}). */
    alias: string;
    /** Delete the per-project D1/R2 too (only when this is the alias's last deployment). */
    deleteResources: boolean;
    dispatchNamespace: string;
    scriptName: string;
}

/**
 * Build the composite `destroy` the sweep calls per target. The versioned
 * dispatch script is always deleted (404-tolerant, so retries are safe). The
 * per-project D1/R2 are deleted **only when `deleteResources` is set** — i.e.
 * this is the last remaining deployment of its alias (org/project deletion), so
 * a routine version prune never destroys the database the active version still
 * serves from. D1 delete is retryable; R2 is best-effort: a non-empty bucket
 * can't be deleted through the REST API (object purge needs the S3/data
 * credential this context lacks), so an R2 failure is logged rather than
 * blocking the rest of teardown forever — a non-empty tenant bucket is the one
 * resource that still needs a follow-up purge.
 */
export const createResourceTeardown =
    (api: CloudflareApi, onR2Error?: (bucket: string, error: unknown) => void) =>
    async (reference: ResourceRef): Promise<void> => {
        await api.deleteDispatchScript({ namespace: reference.dispatchNamespace, scriptName: reference.scriptName });

        if (!reference.deleteResources) {
            return;
        }

        const database = await api.findD1DatabaseByName(tenantD1Name(reference.alias));

        if (database) {
            await api.deleteD1Database(database.uuid);
        }

        const bucket = tenantR2Bucket(reference.alias);

        try {
            await api.deleteR2Bucket(bucket);
        } catch (error) {
            // Non-empty bucket (or transient R2 error): logged, not fatal.
            onR2Error?.(bucket, error);
        }
    };
