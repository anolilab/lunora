/**
 * The periodic metric-alert sweep (§ Observability). Runs from the control
 * plane's every-minute `scheduled()` tick alongside the uptime sweep: re-evaluate
 * every enabled metric-window rule (`error_rate` / `latency_p95` / `llm_cost`)
 * over its rolling window and fire/clear as its firing state crosses.
 *
 * Metric rules also evaluate inline on telemetry ingest (fast feedback), but a
 * window that goes quiet — the error rate falling to 0 because no new spans
 * arrive — is never re-examined by ingest, so a firing rule would never clear and
 * a breach that developed without a fresh ingest would never fire. This sweep
 * closes that gap: it drives the SAME level-triggered `fireMetricRules` the ingest
 * uses, over the SAME `alertRuleState` latch, so the two paths can't drift and a
 * breach alerts exactly once regardless of which path first sees it.
 *
 * Expressed as a pure function over the injected {@link ControlPlaneDb} ports,
 * like `runUptimeSweep`, so the evaluate→fire/clear logic is testable against a
 * fake store. The edge (`src/server.ts`) supplies the real D1 and delivers the
 * returned alerts.
 */
import type { ControlPlaneDb } from "../deploy/sweeps";
import type { AlertChannel, AlertDelivery, MetricObservation, MetricRule, MetricTarget } from "./alerts";
import { fireMetricRules } from "./alerts";

/** An `alertRules` row as the control-plane store returns it. */
interface AlertRuleRow {
    _id: string;
    channel: AlertChannel;
    comparator?: "gt" | "lt";
    destination: string;
    enabled: boolean;
    functionPath?: string;
    name: string;
    organizationId: string;
    target: string;
    threshold: number;
    windowMinutes?: number;
}

/** A span observation row scanned for a rule's window. */
interface ObservationRow extends MetricObservation {
    organizationId: string;
}

/** A metric rule's persisted firing latch (`alertRuleState`). */
interface AlertRuleStateRow {
    _id: string;
    firing: boolean;
    ruleId: string;
}

export interface AlertSweepResult {
    /** Rules whose window fell back under threshold this sweep (latch cleared). */
    cleared: number;
    /** Alerts fired this sweep, for the edge to deliver + mark delivered. */
    deliveries: AlertDelivery[];
    /** Orgs whose recent observations were scanned (had ≥1 enabled metric rule). */
    evaluatedOrgs: number;
}

/** Options for {@link runAlertSweep}. */
export interface AlertSweepOptions {
    now: number;
    /** Max recent observations scanned per org (bounds the D1 read). */
    scanLimit?: number;
}

/** The metric-window rule targets this sweep evaluates. */
const METRIC_TARGETS = new Set<MetricTarget>(["error_rate", "latency_p95", "llm_cost"]);

/** Recent spans scanned per org when slicing metric windows (bounds the read). */
const DEFAULT_SCAN_LIMIT = 2000;

/** Map an `alertRules` row to the shared {@link MetricRule} the firing loop reads. */
const toMetricRule = (row: AlertRuleRow): MetricRule => ({
    channel: row.channel,
    comparator: row.comparator ?? "gt",
    destination: row.destination,
    functionPath: row.functionPath,
    name: row.name,
    ruleId: row._id,
    target: row.target as MetricTarget,
    threshold: row.threshold,
    windowMinutes: row.windowMinutes ?? 60,
});

/**
 * Re-evaluate every enabled metric rule over its window and fire/clear as its
 * latch crosses. Reads all rules once, groups the metric ones by org, and — only
 * for orgs that actually have such a rule — scans that org's recent observations
 * and drives {@link fireMetricRules} against the persisted `alertRuleState`.
 * Returns the fired alerts for the edge to deliver.
 */
export const runAlertSweep = async (database: ControlPlaneDb, options: AlertSweepOptions): Promise<AlertSweepResult> => {
    const scanLimit = options.scanLimit ?? DEFAULT_SCAN_LIMIT;

    const { page: rulePage } = await database.findMany("alertRules", {});
    const rulesByOrg = new Map<string, MetricRule[]>();

    for (const row of rulePage as AlertRuleRow[]) {
        if (row.enabled && METRIC_TARGETS.has(row.target as MetricTarget)) {
            const list = rulesByOrg.get(row.organizationId) ?? [];

            list.push(toMetricRule(row));
            rulesByOrg.set(row.organizationId, list);
        }
    }

    if (rulesByOrg.size === 0) {
        return { cleared: 0, deliveries: [], evaluatedOrgs: 0 };
    }

    // Prior firing latches, read once and keyed by ruleId (across all orgs — the
    // table is small, one row per metric rule).
    const { page: statePage } = await database.findMany("alertRuleState", {});
    const stateByRule = new Map((statePage as AlertRuleStateRow[]).map((row) => [row.ruleId, row]));

    const deliveries: AlertDelivery[] = [];
    let cleared = 0;

    for (const [organizationId, rules] of rulesByOrg) {
        // The org's recent spans, newest-first and bounded — the windows are sliced
        // from these in `fireMetricRules`.
        // eslint-disable-next-line no-await-in-loop -- one bounded read per org with a metric rule; serialized like the uptime sweep
        const { page: observationPage } = await database.findMany("observations", {
            limit: scanLimit,
            orderBy: [{ startedAt: "desc" }],
            where: { organizationId },
        });
        const observations = observationPage as ObservationRow[];

        // eslint-disable-next-line no-await-in-loop -- serialized D1 writes, one org at a time
        const outcome = await fireMetricRules<string>(
            rules,
            observations,
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

        deliveries.push(...outcome.deliveries);
        cleared += outcome.cleared;
    }

    return { cleared, deliveries, evaluatedOrgs: rulesByOrg.size };
};
