/**
 * The hourly anomaly sweep (plan 365 W4): measure each organization's last
 * fully-read hour per signal, score it against that organization's rolling
 * baseline (`./anomaly`), persist the advanced baseline, and fire/clear its
 * `usage_anomaly` / `error_anomaly` / `storage_anomaly` rules over the shared
 * `alertRuleState` latch.
 *
 * Only organizations with an enabled anomaly rule are measured, so the work and
 * the `anomalyBaselines` rows (one per signal, three per organization at most)
 * are bounded by the rules people actually wrote. A baseline starts when the
 * first rule does and scores after {@link MIN_ANOMALY_SAMPLES} hours.
 *
 * Where the signals come from — stores every target writes to, so the score is
 * target-agnostic:
 *
 * - `requests` — the `platformUsage` ledger's `requests` rows. The
 *   `cloudflare-wfp` and `cloudflare-workers` readbacks write them hourly; a
 *   `celld-vps` box writes them from its usage reports. Display-only
 *   (`billable: false`) rows count: an anomaly is about traffic, not the invoice.
 * - `storage` — the ledger rows of D1 and Durable Object row operations
 *   (`STORAGE_METERS`), priced at the rate card in nano-cents. Display-only rows
 *   count here too.
 * - `errors` — error-level `observations` (OTLP spans) started in the bucket, so
 *   only tenants that ship telemetry have an error signal.
 *
 * **The ledger signals score an hour by when the usage HAPPENED** — the window
 * each row was read for (`windowStart`/`windowEnd`), apportioned across the
 * hours a multi-hour window covers — never by when the row was written. Scoring
 * by `createdAt` turned a catch-up run (two hours read at once after one failed
 * read) into a spike, and a window split at a month boundary into a collapse.
 * Rows without a window (a tenant's own `usage.ingest`) count in the hour they
 * were written, for their own month only.
 *
 * Because the readback runs on the same hourly tick, the ledger signals score
 * an older hour ({@link SIGNAL_DELAY_HOURS}): requests the hour the previous
 * tick's readback finished, storage the hour before that (Cloudflare's hourly
 * datasets are read only once an hour has closed for the lag). And an hour is
 * scored only once every readback source of the organization has read past it
 * ({@link STALLED_SOURCE_MS}); a source still behind skips the hour — no score,
 * no baseline update — rather than scoring a dip that its catch-up then refills.
 *
 * An hour of a month that has closed is never scored: ledger compaction can fold
 * the whole closed month onto one of its rows.
 *
 * Idempotent per bucket: a baseline row remembers the bucket it last folded in, so
 * a re-run of the same hour re-uses the stored reading (letting a crash between
 * the baseline write and the rule writes finish its rules) and never folds the
 * hour in twice.
 */
import type { UsageMeter } from "../billing/spend";
import { RATE_CARD } from "../billing/spend";
import { usageScopeKey } from "../deploy/sweeps";
import type { ControlPlaneDatabase } from "../store";
import { drainTable } from "../store";
import type { UsageFamily } from "../targets/driver";
import type { AlertChannel, AlertDelivery, AnomalyTarget } from "./alerts";
import { ANOMALY_TARGETS } from "./alerts";
import type { AnomalyBaseline, AnomalyReading, AnomalyRule, AnomalySignal, AnomalySilence, AnomalyTransition } from "./anomaly";
import { ANOMALY_BUCKET_MS, ANOMALY_SIGNAL, fireAnomalyRules, isSilenced, MIN_ANOMALY_SAMPLES, scoreBucket, STORAGE_METERS } from "./anomaly";

/** An `alertRules` row as this sweep reads it. */
interface AlertRuleRow {
    _id: string;
    channel: AlertChannel;
    comparator?: "gt" | "lt";
    destination: string;
    enabled: boolean;
    name: string;
    organizationId: string;
    target: string;
    threshold: number;
}

/** An `anomalyBaselines` row. */
interface BaselineRow extends AnomalyBaseline {
    _id: string;
    lastBucketStart: number;
    lastMean: number;
    lastScore: number;
    lastValue: number;
    signal: AnomalySignal;
}

/** A fired-or-cleared anomaly rule, with the organization it belongs to (from the rule row, never a caller). */
export interface OrganizationAnomalyTransition extends AnomalyTransition {
    organizationId: string;
}

export interface AnomalySweepResult {
    /** Alerts fired this pass, for the edge to deliver. */
    deliveries: AlertDelivery[];
    /** Signals scored this pass (a re-run of the same hour scores none). */
    scored: number;
    /** Every rule that fired or cleared — what an enforcement action keys on. */
    transitions: OrganizationAnomalyTransition[];
}

/**
 * Error spans counted per bucket at most. ponytail: a capped page — past it the
 * value saturates at the cap, which still scores as a spike against any baseline
 * below it; a COUNT read is the upgrade if a tenant's normal hour exceeds it.
 */
const ERROR_SCAN_CAP = 1000;

/** The UTC month an instant falls in — the ledger's period key. */
const periodStartOf = (at: number): number => {
    const date = new Date(at);

    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
};

/**
 * How many hours behind the last closed hour each signal scores. The readback
 * runs on the same tick as this sweep, so the hour it is reading right now is
 * not yet in the ledger: requests score the hour the PREVIOUS tick's readback
 * finished, and storage — read only once an hour has closed for the lag — the
 * hour before that. Errors are ingested as they happen.
 */
export const SIGNAL_DELAY_HOURS: Record<AnomalySignal, number> = { errors: 0, requests: 1, storage: 2 };

/** The readback families each ledger signal is read from. */
const SIGNAL_FAMILIES: Record<AnomalySignal, ReadonlyArray<UsageFamily>> = { errors: [], requests: ["requests"], storage: ["d1", "durableObjects"] };

/**
 * How long a readback source that is behind holds back its organization's
 * score. A source further behind than this is treated as down and no longer
 * waited for (its status is on the Usage tab), so one broken source cannot
 * switch anomaly detection off for good.
 */
export const STALLED_SOURCE_MS = 6 * ANOMALY_BUCKET_MS;

/** A ledger row as the measure reads it. `.global()` rows answer SQL NULL for unset columns. */
interface LedgerRow {
    createdAt: number;
    periodStart: number;
    quantity: number;
    windowEnd?: null | number;
    windowStart?: null | number;
}

/**
 * How much of a ledger row's quantity happened in `[start, end)`: the share of
 * its window that overlaps the hour. A row without a window counts whole in the
 * hour it was written, and only for its own month — so a compaction survivor
 * that carries a whole closed month is never read as one hour.
 */
export const usageInHour = (row: LedgerRow, start: number, end: number): number => {
    const quantity = Number.isFinite(row.quantity) && row.quantity > 0 ? row.quantity : 0;
    const { windowEnd, windowStart } = row;

    if (windowStart != null && windowEnd != null && windowEnd > windowStart) {
        const overlap = Math.min(end, windowEnd) - Math.max(start, windowStart);

        return overlap > 0 ? (quantity * overlap) / (windowEnd - windowStart) : 0;
    }

    return row.createdAt >= start && row.createdAt < end && row.periodStart === periodStartOf(row.createdAt) ? quantity : 0;
};

/**
 * The org's `kind` usage that happened in `[start, end)`. A row is written no
 * earlier than its window ends, so every row whose window overlaps the hour was
 * created at or after `start`; that bounds the read.
 */
const measureLedger = async (database: ControlPlaneDatabase, organizationId: string, kind: UsageMeter, start: number, end: number): Promise<number> => {
    const rows = await drainTable<LedgerRow>(database, "platformUsage", { where: { createdAt: { gte: start }, kind, organizationId } });

    return rows.reduce((sum, row) => sum + usageInHour(row, start, end), 0);
};

/** The org's `requests` events recorded in `[start, end)`. */
const measureRequests = async (database: ControlPlaneDatabase, organizationId: string, start: number, end: number): Promise<number> =>
    measureLedger(database, organizationId, "requests", start, end);

/** The org's storage row operations recorded in `[start, end)`, priced in nano-cents. */
const measureStorage = async (database: ControlPlaneDatabase, organizationId: string, start: number, end: number): Promise<number> => {
    const quantities = await Promise.all(STORAGE_METERS.map(async (meter) => measureLedger(database, organizationId, meter, start, end)));

    return STORAGE_METERS.reduce((sum, meter, index) => sum + (quantities[index] ?? 0) * RATE_CARD[meter].nanoCentsPerUnit, 0);
};

/** The org's error spans started in `[start, end)`, capped at {@link ERROR_SCAN_CAP}. */
const measureErrors = async (database: ControlPlaneDatabase, organizationId: string, start: number, end: number): Promise<number> => {
    const { page } = await database.findMany("observations", {
        limit: ERROR_SCAN_CAP,
        where: { level: "error", organizationId, startedAt: { gte: start, lt: end } },
    });

    return page.length;
};

const MEASURE: Record<AnomalySignal, typeof measureRequests> = { errors: measureErrors, requests: measureRequests, storage: measureStorage };

/** The signals measured from the `platformUsage` ledger, which compaction rewrites once a month closes. */
const LEDGER_SIGNALS: ReadonlySet<AnomalySignal> = new Set<AnomalySignal>(["requests", "storage"]);

/**
 * Whether every readback source of the organization has read past `end` for
 * `signal`: this control plane's cell (`cell`, the `cloudflare-wfp` scope) and
 * the organization's connected accounts. A source with no checkpoint yet is
 * not a source of this signal; one more than {@link STALLED_SOURCE_MS} behind
 * is treated as down.
 */
const readThrough = async (
    database: ControlPlaneDatabase,
    input: { cell: string | undefined; end: number; organizationId: string; signal: AnomalySignal },
): Promise<boolean> => {
    const families = SIGNAL_FAMILIES[input.signal];

    if (families.length === 0) {
        return true;
    }

    const accounts = await drainTable<{ _id: string }>(database, "cloudflareAccounts", { where: { organizationId: input.organizationId } });
    const scopes = [
        ...(input.cell === undefined ? [] : [{ scope: input.cell, target: "cloudflare-wfp" }]),
        ...accounts.map((account) => {
            return { scope: account._id, target: "cloudflare-workers" };
        }),
    ];
    const checkpoints = await Promise.all(
        scopes.flatMap(({ scope, target }) =>
            families.map(async (family) => {
                const { page } = await database.findMany("usageCheckpoints", { where: { scopeKey: usageScopeKey(scope, family), target } });

                return (page as { readAtMs?: null | number }[]).at(0)?.readAtMs ?? undefined;
            }),
        ),
    );

    return checkpoints.every((readAtMs) => readAtMs === undefined || readAtMs >= input.end || readAtMs < input.end - STALLED_SOURCE_MS);
};

/** Map a rule row onto the firing loop's shape. */
const toAnomalyRule = (row: AlertRuleRow): AnomalyRule => {
    return {
        channel: row.channel,
        comparator: row.comparator ?? "gt",
        destination: row.destination,
        name: row.name,
        ruleId: row._id,
        target: row.target as AnomalyTarget,
        threshold: row.threshold,
    };
};

/**
 * Score one signal for one org's bucket: the stored reading when this bucket was
 * already folded in, nothing when it is silenced or straddles a period boundary,
 * otherwise a fresh measurement folded into the baseline.
 */
const readSignal = async (
    database: ControlPlaneDatabase,
    input: {
        baseline: BaselineRow | undefined;
        /** This control plane's cell — the `cloudflare-wfp` readback scope. */
        cell: string | undefined;
        end: number;
        now: number;
        organizationId: string;
        signal: AnomalySignal;
        silences: ReadonlyArray<AnomalySilence>;
        start: number;
    },
): Promise<{ fresh: boolean; reading?: AnomalyReading }> => {
    const { baseline, end, now, organizationId, signal, start } = input;

    if (baseline !== undefined && baseline.lastBucketStart >= start) {
        // Already folded in. Re-offer the stored reading only for THIS bucket and only
        // once warmed up; a stale one would re-arm rules on an old hour.
        return baseline.lastBucketStart === start && baseline.samples > MIN_ANOMALY_SAMPLES
            ? { fresh: false, reading: { mean: baseline.lastMean, score: baseline.lastScore, value: baseline.lastValue } }
            : { fresh: false };
    }

    // The ledger compacts a closed period by folding its rows onto a survivor, so
    // an hour of a month that has closed is never scored.
    if (LEDGER_SIGNALS.has(signal) && periodStartOf(start) !== periodStartOf(now)) {
        return { fresh: false };
    }

    if (isSilenced(input.silences, signal, start, end)) {
        return { fresh: false };
    }

    // A source still catching up would score a dip its catch-up then refills: skip the hour.
    if (!(await readThrough(database, { cell: input.cell, end, organizationId, signal }))) {
        return { fresh: false };
    }

    const value = await MEASURE[signal](database, organizationId, start, end);
    const { next, reading } = scoreBucket(signal, baseline, value);
    const row = { ...next, lastBucketStart: start, lastMean: reading.mean, lastScore: reading.score, lastValue: reading.value, updatedAt: now };

    await (baseline === undefined
        ? database.insert("anomalyBaselines", { ...row, createdAt: now, organizationId, signal })
        : database.patch(baseline._id, row, "anomalyBaselines"));

    // A warming baseline folds the hour in but offers no reading: its score is 0 by
    // construction, and offering it would clear a rule for no reason.
    return { fresh: true, ...(baseline !== undefined && baseline.samples >= MIN_ANOMALY_SAMPLES ? { reading } : {}) };
};

/**
 * Run one pass over every organization with an enabled anomaly rule. `cell` is
 * this control plane's cell (`LUNORA_CELL`), whose readback checkpoints say
 * which hours the `cloudflare-wfp` ledger rows are complete for.
 */
export const runAnomalySweep = async (database: ControlPlaneDatabase, options: { cell?: string; now: number }): Promise<AnomalySweepResult> => {
    const closed = Math.floor(options.now / ANOMALY_BUCKET_MS) * ANOMALY_BUCKET_MS;
    const ruleRows = await drainTable<AlertRuleRow>(database, "alertRules");
    const rulesByOrg = new Map<string, AnomalyRule[]>();

    for (const row of ruleRows) {
        if (row.enabled && ANOMALY_TARGETS.has(row.target as AnomalyTarget)) {
            rulesByOrg.set(row.organizationId, [...(rulesByOrg.get(row.organizationId) ?? []), toAnomalyRule(row)]);
        }
    }

    const deliveries: AlertDelivery[] = [];
    const transitions: OrganizationAnomalyTransition[] = [];
    let scored = 0;

    for (const [organizationId, rules] of rulesByOrg) {
        /* eslint-disable no-await-in-loop -- bounded reads per org with an anomaly rule, serialized like the alert sweep */
        const [{ page: baselinePage }, { page: silencePage }, { page: statePage }] = await Promise.all([
            database.findMany("anomalyBaselines", { where: { organizationId } }),
            database.findMany("anomalySilences", { where: { organizationId } }),
            database.findMany("alertRuleState", { where: { organizationId } }),
        ]);
        const baselines = new Map((baselinePage as BaselineRow[]).map((row) => [row.signal, row]));
        const stateByRule = new Map((statePage as { _id: string; firing: boolean; ruleId: string }[]).map((row) => [row.ruleId, row]));
        const readings: Partial<Record<AnomalySignal, AnomalyReading>> = {};

        for (const signal of new Set(rules.map((rule) => ANOMALY_SIGNAL[rule.target]))) {
            const end = closed - SIGNAL_DELAY_HOURS[signal] * ANOMALY_BUCKET_MS;
            const result = await readSignal(database, {
                baseline: baselines.get(signal),
                cell: options.cell,
                end,
                now: options.now,
                organizationId,
                signal,
                silences: silencePage as AnomalySilence[],
                start: end - ANOMALY_BUCKET_MS,
            });

            scored += result.fresh ? 1 : 0;

            if (result.reading !== undefined) {
                readings[signal] = result.reading;
            }
        }

        const outcome = await fireAnomalyRules<string>(
            rules,
            readings,
            organizationId,
            {
                insertAlert: (row) => database.insert("alerts", row) as Promise<string>,
                wasFiring: (ruleId) => stateByRule.get(ruleId)?.firing ?? false,
                writeState: async (ruleId, firing, value) => {
                    const existing = stateByRule.get(ruleId);
                    const patch = { firing, lastEvaluatedAt: options.now, lastValue: value, updatedAt: options.now };

                    await (existing
                        ? database.patch(existing._id, patch, "alertRuleState")
                        : database.insert("alertRuleState", { createdAt: options.now, organizationId, ruleId, ...patch }));
                },
            },
            options.now,
        );
        /* eslint-enable no-await-in-loop */

        deliveries.push(...outcome.deliveries);
        transitions.push(
            ...outcome.transitions.map((transition) => {
                return { ...transition, organizationId };
            }),
        );
    }

    return { deliveries, scored, transitions };
};
