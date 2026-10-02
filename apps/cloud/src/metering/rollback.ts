/**
 * Request-count readback → `platformUsage`. A `readback` target records its
 * tenants' requests on its own side (on `cloudflare-wfp`, the dispatcher writes
 * one Analytics Engine data point per request); this control-plane rollback
 * folds those counts, read through the target driver's `usage`, back into the
 * metering ledger that spend caps, the usage summary, and the usage chart all
 * read. Without it the ledger only ever holds what tenants self-report over
 * `POST /v1/usage`, so in practice it stays empty and spend enforcement has
 * nothing to evaluate.
 *
 * Pure over injected ports (the driver's reader, the ledger writer, the per-scope
 * checkpoint). Delta-based: it reads only `timestamp > checkpoint` and advances
 * the checkpoint after, so repeated runs never double count. Per-row failure is
 * swallowed and the checkpoint still advances — the same fail-safe direction as
 * `usage.rollup` (under-count, never over-bill).
 */
import type { UsageRow } from "../targets/driver";

/** First-run window when the scope has no checkpoint yet — bounds the initial backfill. */
export const BOOTSTRAP_WINDOW_MS = 60 * 60 * 1000;

/** Which org (and deployment) a resource's request counts belong to. */
export interface UsageAttribution {
    deploymentId?: string;
    organizationId: string;
}

export interface UsageRollbackPorts {
    /** The scope's last readback boundary (epoch ms), or undefined on first run. */
    getCheckpoint: () => Promise<number | undefined>;
    /** Current wall clock (epoch ms) — injected for determinism. */
    now: number;
    /** Read summed request counts per resource since `sinceMs` (the driver's `usage`). */
    read: (sinceMs: number) => Promise<UsageRow[]>;
    /** Append a `requests` row to the platformUsage ledger. */
    record: (input: { attribution: UsageAttribution; quantity: number }) => Promise<void>;
    /** Resolve a resource (`deployments.resourceRef`) → its org/deployment, or undefined if unknown. */
    resolveResource: (resourceRef: string) => UsageAttribution | undefined;
    /** Advance the checkpoint to `ms` after the read pass. */
    setCheckpoint: (ms: number) => Promise<void>;
}

export interface UsageRollbackResult {
    /** Resources whose counts were recorded into the ledger. */
    attributed: number;
    /** Attributed resources whose ledger write threw (dropped — under-count). */
    failed: number;
    /** Total requests folded into the ledger this run. */
    requests: number;
    /** Rows for resources with no matching deployment (dropped). */
    skipped: number;
}

/**
 * Fold the request-count delta since the scope's checkpoint into the ledger,
 * then advance the checkpoint. Idempotent across runs (delta-read); a per-row
 * ledger failure is dropped rather than retried so the checkpoint can always
 * advance (under-count, never double-bill). Re-throws only if the read
 * itself fails — the checkpoint then stays put and the next run retries.
 */
export const runUsageRollback = async (ports: UsageRollbackPorts): Promise<UsageRollbackResult> => {
    const checkpoint = await ports.getCheckpoint();
    const since = checkpoint ?? ports.now - BOOTSTRAP_WINDOW_MS;
    const rows = await ports.read(since);

    let attributed = 0;
    let failed = 0;
    let skipped = 0;
    let requests = 0;

    for (const row of rows) {
        if (row.requests <= 0) {
            continue;
        }

        const attribution = ports.resolveResource(row.resourceRef);

        if (!attribution) {
            skipped += 1;
            continue;
        }

        try {
            // eslint-disable-next-line no-await-in-loop -- sequential ledger writes; per-scope resource counts are small
            await ports.record({ attribution, quantity: row.requests });
            attributed += 1;
            requests += row.requests;
        } catch {
            // Drop this window's count for the resource rather than block the
            // checkpoint — a retry would re-record every already-written one.
            failed += 1;
        }
    }

    await ports.setCheckpoint(ports.now);

    return { attributed, failed, requests, skipped };
};
