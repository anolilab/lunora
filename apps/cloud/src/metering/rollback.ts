/**
 * Usage readback → `platformUsage`. A `readback` target records its tenants'
 * usage on its own side: on `cloudflare-wfp`, the dispatcher writes one
 * Analytics Engine data point per request, and Cloudflare's GraphQL datasets
 * count D1 and Durable Object rows. This control-plane rollback reads those
 * counts through the target driver's `usage` and folds them back into the
 * metering ledger. Spend caps, the usage summary and the usage chart all read
 * that ledger. Without the rollback, the ledger only holds what tenants
 * self-report over `POST /v1/usage`, so in practice it stays empty and spend
 * enforcement has nothing to evaluate.
 *
 * The rollback is pure over injected ports: the source's reader, the ledger
 * writer, and the checkpoint of one (scope, family). It is delta-based. It reads
 * only the window after the checkpoint and advances the checkpoint after each
 * window, so repeated runs never double count. A failed ledger write for one
 * row is swallowed and the checkpoint still advances. That is the same
 * fail-safe direction as `usage.rollup`: under-count, never over-bill.
 *
 * Every window is billed to its own month. A window that crosses a month
 * boundary is split there, and each part is read and recorded with that
 * part's `periodStart`. Billing the whole window to the month the sweep ran in
 * put the last hour of every month on the next month's bill.
 */
import type { PeriodUsage, UsageMeter } from "../billing/spend";
import { isUsageMeter, periodStartOf } from "../billing/spend";
import type { UsageRow, UsageSource, UsageWindow } from "../targets/driver";

/** First-run window when the scope has no checkpoint yet — bounds the initial backfill. */
export const BOOTSTRAP_WINDOW_MS = 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

/**
 * How long after an hour ends before an `hourly` source reads it. Cloudflare's
 * adaptive GraphQL datasets fill a bucket for a few minutes after it closes;
 * reading too early records part of the hour and skips the rest.
 */
export const HOURLY_ANALYTICS_LAG_MS = 15 * 60 * 1000;

/**
 * The most an `hourly` source reads in one run. After an outage, the backlog is
 * caught up a day per hourly run. That keeps every query far below the
 * datasets' row limit.
 */
export const MAX_HOURLY_CATCHUP_MS = 24 * HOUR_MS;

/** Which org (and deployment) a resource's usage belongs to. */
export interface UsageAttribution {
    deploymentId?: string;
    organizationId: string;
    /** The host the tenant runs on (`deployments.placementRef`) — recorded on its usage rows. */
    placementRef?: string;
}

/** One ledger row the rollback writes. */
export interface UsageRecord {
    attribution: UsageAttribution;
    meter: UsageMeter;
    /** The UTC month the usage happened in, which is not always the month the sweep runs in. */
    periodStart: number;
    quantity: number;
}

export interface UsageRollbackPorts {
    /** Whether the source reads up to now (`continuous`) or only closed hours (`hourly`). */
    cadence: UsageSource["cadence"];
    /** The checkpoint of this (scope, family) in epoch ms, or undefined on the first run. */
    getCheckpoint: () => Promise<number | undefined>;
    /** Current wall clock (epoch ms) — injected for determinism. */
    now: number;
    /** Read what each resource consumed in one window (the source's `read`, bound to its scope). */
    read: (window: UsageWindow) => Promise<UsageRow[]>;
    /** Append one row to the `platformUsage` ledger. */
    record: (record: UsageRecord) => Promise<void>;
    /** Resolve a resource (`deployments.resourceRef`) → its org/deployment, or undefined if unknown. */
    resolveResource: (resourceRef: string) => UsageAttribution | undefined;
    /** Advance the checkpoint to `ms`, after a window was read and recorded. */
    setCheckpoint: (ms: number) => Promise<void>;
}

export interface UsageRollbackResult {
    /** Rows (one resource in one window) with at least one meter recorded into the ledger. */
    attributed: number;
    /** Ledger writes that threw. The quantity is dropped, so this under-counts. */
    failed: number;
    /** What was recorded this run, by meter. */
    recorded: PeriodUsage;
    /** Rows of resources with no matching deployment. These are dropped. */
    skipped: number;
    /** The total quantity, across meters, of the skipped rows. The sweep reports it, so dropped volume stays visible. */
    unattributed: number;
}

/** A positive, finite quantity; anything else records nothing. */
const positive = (value: number | undefined): number => (value !== undefined && Number.isFinite(value) && value > 0 ? value : 0);

/** The window this run reads, or `undefined` when nothing new has closed yet. */
const windowOf = (ports: Pick<UsageRollbackPorts, "cadence" | "now">, checkpoint: number | undefined): undefined | UsageWindow => {
    if (ports.cadence === "continuous") {
        return { sinceMs: checkpoint ?? ports.now - BOOTSTRAP_WINDOW_MS, untilMs: ports.now };
    }

    // Only hours that ended at least the lag ago, so a bucket is never read while it still fills.
    const closed = Math.floor((ports.now - HOURLY_ANALYTICS_LAG_MS) / HOUR_MS) * HOUR_MS;
    const sinceMs = checkpoint ?? closed - BOOTSTRAP_WINDOW_MS;
    const untilMs = Math.min(closed, sinceMs + MAX_HOURLY_CATCHUP_MS);

    return untilMs > sinceMs ? { sinceMs, untilMs } : undefined;
};

/** The first instant of the UTC month after `at`. */
const nextMonthStart = (at: number): number => {
    const date = new Date(at);

    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
};

/**
 * Split a window at every month boundary inside it. The part before a boundary
 * ends ON the boundary, so the parts still partition the window.
 */
export const splitByMonth = (window: UsageWindow): UsageWindow[] => {
    const parts: UsageWindow[] = [];
    let { sinceMs } = window;

    for (let boundary = nextMonthStart(sinceMs); boundary < window.untilMs; boundary = nextMonthStart(boundary)) {
        parts.push({ sinceMs, untilMs: boundary });
        sinceMs = boundary;
    }

    parts.push({ sinceMs, untilMs: window.untilMs });

    return parts;
};

/** A result with nothing in it. */
const emptyResult = (): UsageRollbackResult => {
    return { attributed: 0, failed: 0, recorded: {}, skipped: 0, unattributed: 0 };
};

/** Two results added up. */
const addResults = (a: UsageRollbackResult, b: UsageRollbackResult): UsageRollbackResult => {
    const recorded: PeriodUsage = { ...a.recorded };

    for (const [meter, quantity] of Object.entries(b.recorded) as [UsageMeter, number][]) {
        recorded[meter] = (recorded[meter] ?? 0) + quantity;
    }

    return {
        attributed: a.attributed + b.attributed,
        failed: a.failed + b.failed,
        recorded,
        skipped: a.skipped + b.skipped,
        unattributed: a.unattributed + b.unattributed,
    };
};

/** Record one row's meters into the ledger, and say what that did. */
const recordRow = async (ports: UsageRollbackPorts, row: UsageRow, periodStart: number): Promise<UsageRollbackResult> => {
    const tally = emptyResult();
    const meters = Object.entries(row.meters).flatMap(([meter, quantity]) =>
        isUsageMeter(meter) && positive(quantity) > 0 ? [{ meter, quantity: positive(quantity) }] : [],
    );

    if (meters.length === 0) {
        return tally;
    }

    const attribution = ports.resolveResource(row.resourceRef);

    if (!attribution) {
        return { ...tally, skipped: 1, unattributed: meters.reduce((sum, { quantity }) => sum + quantity, 0) };
    }

    for (const { meter, quantity } of meters) {
        try {
            // eslint-disable-next-line no-await-in-loop -- sequential ledger writes; per-scope resource counts are small
            await ports.record({ attribution, meter, periodStart, quantity });
            tally.recorded[meter] = (tally.recorded[meter] ?? 0) + quantity;
            tally.attributed = 1;
        } catch {
            // Drop this meter's count for the resource rather than block the
            // checkpoint — a retry would re-record every already-written one.
            tally.failed += 1;
        }
    }

    return tally;
};

/**
 * Fold the usage since the checkpoint into the ledger, one month-part at a time,
 * and advance the checkpoint after each part.
 *
 * - Idempotent across runs, because every read is a delta.
 * - A failed ledger write for one row is dropped, not retried, so the
 *   checkpoint can always advance (under-count, never double-bill).
 * - A failed read re-throws. The checkpoint then stays at the last part that
 *   succeeded, and the next run retries from there.
 */
export const runUsageRollback = async (ports: UsageRollbackPorts): Promise<UsageRollbackResult> => {
    const window = windowOf(ports, await ports.getCheckpoint());

    if (window === undefined) {
        return emptyResult();
    }

    let result = emptyResult();

    /* eslint-disable no-await-in-loop -- parts are sequential: each advances the checkpoint the next one starts from */
    for (const part of splitByMonth(window)) {
        // A part's usage happened in the part's month. The part is `(since, until]` or
        // `[since, until)` and never crosses a month, so its start names that month.
        const periodStart = periodStartOf(part.sinceMs);
        const rows = await ports.read(part);

        for (const row of rows) {
            result = addResults(result, await recordRow(ports, row, periodStart));
        }

        await ports.setCheckpoint(part.untilMs);
    }
    /* eslint-enable no-await-in-loop */

    return result;
};
