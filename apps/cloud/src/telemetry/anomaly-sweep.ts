/**
 * The hourly anomaly sweep (plan 365 W4): measure each organization's last
 * completed hour, score it against that organization's rolling baseline
 * (`./anomaly`), persist the advanced baseline, and fire/clear its
 * `usage_anomaly` / `error_anomaly` / `storage_anomaly` rules over the shared
 * `alertRuleState` latch.
 *
 * Only organizations with an enabled anomaly rule are measured, so the work and
 * the `anomalyBaselines` rows (one per signal, three per organization at most)
 * are bounded by the rules people actually wrote. A baseline starts when the first rule does and
 * scores after {@link MIN_ANOMALY_SAMPLES} hours.
 *
 * Where the two signals come from — both stores every target writes to, so the
 * score is target-agnostic:
 *
 * - `requests` — the `platformUsage` ledger's `requests` rows created in the
 *   bucket. The `cloudflare-wfp` and `cloudflare-workers` readbacks write them
 *   hourly; a `celld-vps` box writes them from its usage reports. Display-only
 *   (`billable: false`) rows count: an anomaly is about traffic, not the invoice.
 * - `storage` — the ledger rows of D1 and Durable Object row operations
 *   (`STORAGE_METERS`) created in the bucket, priced at the rate card in
 *   nano-cents. The
 *   `cloudflare-wfp` and `cloudflare-workers` readbacks write them hourly, an
 *   hour or two behind (they read only closed hours of Cloudflare's datasets).
 *   Display-only rows count here too.
 * - `errors` — error-level `observations` (OTLP spans) started in the bucket, so
 *   only tenants that ship telemetry have an error signal.
 *
 * The two ledger signals count only rows of the bucket's own month
 * (`periodStart`). The readback bills a window to the month it happened in, so
 * the first run of a month writes rows of the month before, and compaction can
 * then fold that whole closed month onto one of them. Counting it would score
 * a month of usage as one hour.
 *
 * Idempotent per bucket: a baseline row remembers the bucket it last folded in, so
 * a re-run of the same hour re-uses the stored reading (letting a crash between
 * the baseline write and the rule writes finish its rules) and never folds the
 * hour in twice.
 */
import type { UsageMeter } from "../billing/spend";
import { RATE_CARD } from "../billing/spend";
import type { ControlPlaneDatabase } from "../store";
import { drainTable } from "../store";
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

/** The org's `kind` ledger rows recorded in `[start, end)` for the bucket's own month, summed. */
const measureLedger = async (database: ControlPlaneDatabase, organizationId: string, kind: UsageMeter, start: number, end: number): Promise<number> => {
    const rows = await drainTable<{ quantity: number }>(database, "platformUsage", {
        where: { createdAt: { gte: start, lt: end }, kind, organizationId, periodStart: periodStartOf(start) },
    });

    return rows.reduce((sum, row) => sum + (Number.isFinite(row.quantity) && row.quantity > 0 ? row.quantity : 0), 0);
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

    // The ledger compacts a closed period by folding its rows onto a survivor; a
    // survivor created in the period's last hour would carry the whole month into
    // this bucket. That hour is skipped once a month rather than risk scoring it.
    if (LEDGER_SIGNALS.has(signal) && periodStartOf(start) !== periodStartOf(now)) {
        return { fresh: false };
    }

    if (isSilenced(input.silences, signal, start, end)) {
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

/** Run one pass over every organization with an enabled anomaly rule. */
export const runAnomalySweep = async (database: ControlPlaneDatabase, options: { now: number }): Promise<AnomalySweepResult> => {
    const end = Math.floor(options.now / ANOMALY_BUCKET_MS) * ANOMALY_BUCKET_MS;
    const start = end - ANOMALY_BUCKET_MS;
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
            const result = await readSignal(database, {
                baseline: baselines.get(signal),
                end,
                now: options.now,
                organizationId,
                signal,
                silences: silencePage as AnomalySilence[],
                start,
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
