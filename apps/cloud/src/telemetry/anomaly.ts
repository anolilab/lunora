/**
 * Anomaly scoring (plan 365 W4, D5/D6): an online z-score of one hourly signal
 * against the organization's own rolling baseline, emitted as a derived score
 * that `usage_anomaly` / `error_anomaly` rules threshold.
 *
 * The shape every system in the plan's prior art converged on (vmanomaly,
 * OpenSearch RCF): detection produces a **score**, and ordinary threshold
 * alerting consumes it. So this file holds the detector and a firing loop over
 * the score; the latch (`alertRuleState`), the `alerts` row and the delivery are
 * the same ones the metric rules use.
 *
 * The model, deliberately the simplest that is honest (D6 — no ML before one
 * detector has proven its false-positive rate):
 *
 * - **Baseline** — an exponentially-weighted mean and variance with decay factor
 *   `1 − {@link ANOMALY_DECAY}`, updated once per hourly bucket. One row per
 *   (organization, signal), so its cardinality is bounded by construction.
 * - **Score** — `(value − mean) / σ`, computed against the baseline BEFORE the
 *   bucket is folded in, so a spike cannot drag its own baseline up and mask
 *   itself. σ is floored at the Poisson spread `√mean`: both signals are counts,
 *   and a nearly-flat history would otherwise turn a handful of extra requests
 *   into a forty-sigma event.
 * - **Minimum activity floor** — {@link MIN_ANOMALY_VOLUME}, platform-defined and
 *   not configurable (Vercel's choice, for Vercel's reason): when neither the
 *   bucket nor its baseline reaches the floor, the score is 0, so low-volume
 *   traffic can never page anyone.
 * - **Warm-up** — no score until {@link MIN_ANOMALY_SAMPLES} buckets have been
 *   folded in; a baseline of three hours is not "normal".
 *
 * ponytail: one global hourly baseline per signal, no seasonality. A tenant with a
 * strong daily cycle carries that cycle in its variance, which widens σ rather
 * than modelling the cycle; an hour-of-week baseline is the upgrade if the
 * false-positive rate says so.
 */
import type { AlertChannel, AlertDelivery, AnomalyTarget, Comparator, MetricRulePorts } from "./alerts";
import { compareMetric, transitionFor } from "./alerts";

/** The signal an anomaly target scores. */
export type AnomalySignal = "errors" | "requests";

/** Which signal each anomaly target scores. */
export const ANOMALY_SIGNAL: Record<AnomalyTarget, AnomalySignal> = { error_anomaly: "errors", usage_anomaly: "requests" };

/** One bucket — the readback ledger is filled hourly, so a finer bucket would mostly score empty hours. */
export const ANOMALY_BUCKET_MS = 60 * 60 * 1000;

/** The EWMA weight of the newest bucket: decay factor 0.95, an effective memory of ~20 hours. */
export const ANOMALY_DECAY = 0.05;

/** Buckets folded into a baseline before it scores anything — one day of hours. */
export const MIN_ANOMALY_SAMPLES = 24;

/**
 * Below this many events in BOTH the bucket and its baseline mean, no anomaly can
 * fire. Not configurable, by design: a noisy low-volume detector is the failure
 * that gets every anomaly rule disabled.
 */
export const MIN_ANOMALY_VOLUME: Record<AnomalySignal, number> = { errors: 25, requests: 1000 };

/** Scores are clamped to this magnitude, so a stored score is always finite and comparable. */
export const MAX_ANOMALY_SCORE = 1000;

/** The persisted rolling baseline for one (organization, signal). */
export interface AnomalyBaseline {
    mean: number;
    samples: number;
    variance: number;
}

/** One scored bucket: the value seen, the baseline mean it was compared to, and the score. */
export interface AnomalyReading {
    mean: number;
    score: number;
    value: number;
}

/** A finite, non-negative count — anything else from a row or a report is treated as nothing. */
const asCount = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

/**
 * Score `value` against `baseline` (the baseline as it stood BEFORE this bucket).
 * 0 while warming up and under the activity floor.
 */
export const anomalyScore = (signal: AnomalySignal, baseline: AnomalyBaseline | undefined, rawValue: number): number => {
    const value = asCount(rawValue);

    if (baseline === undefined || baseline.samples < MIN_ANOMALY_SAMPLES) {
        return 0;
    }

    if (Math.max(value, baseline.mean) < MIN_ANOMALY_VOLUME[signal]) {
        return 0;
    }

    const sigma = Math.max(Math.sqrt(Math.max(baseline.variance, 0)), Math.sqrt(Math.max(baseline.mean, 0)), 1);
    const score = (value - baseline.mean) / sigma;

    return Math.min(Math.max(score, -MAX_ANOMALY_SCORE), MAX_ANOMALY_SCORE);
};

/** Fold one bucket into the baseline (EWMA mean + variance). The first bucket seeds it. */
export const advanceBaseline = (baseline: AnomalyBaseline | undefined, rawValue: number): AnomalyBaseline => {
    const value = asCount(rawValue);

    if (baseline === undefined || baseline.samples <= 0) {
        return { mean: value, samples: 1, variance: 0 };
    }

    const delta = value - baseline.mean;

    return {
        mean: baseline.mean + ANOMALY_DECAY * delta,
        // Capped: the count only gates warm-up, and an unbounded counter is one more
        // number that can drift somewhere a reader does not expect.
        samples: Math.min(baseline.samples + 1, 10_000),
        variance: (1 - ANOMALY_DECAY) * (baseline.variance + ANOMALY_DECAY * delta * delta),
    };
};

/** Score a bucket and fold it in, in the one order that keeps a spike out of its own baseline. */
export const scoreBucket = (
    signal: AnomalySignal,
    baseline: AnomalyBaseline | undefined,
    value: number,
): { next: AnomalyBaseline; reading: AnomalyReading } => {
    return {
        next: advanceBaseline(baseline, value),
        reading: { mean: baseline?.mean ?? 0, score: anomalyScore(signal, baseline, value), value: asCount(value) },
    };
};

/** A silence window: while it overlaps a bucket, that bucket of that target's signal is not scored at all. */
export interface AnomalySilence {
    endsAt: number;
    startsAt: number;
    target: AnomalyTarget;
}

/**
 * Whether any silence covers `signal` for the bucket `[start, end)`.
 *
 * A silence makes detection SKIP the bucket — no score, no baseline update — rather
 * than firing and hiding the alert (Vercel's distinction). Skipping the baseline
 * update is the point: a planned load test must not become next week's "normal".
 */
export const isSilenced = (silences: ReadonlyArray<AnomalySilence>, signal: AnomalySignal, start: number, end: number): boolean =>
    silences.some((silence) => ANOMALY_SIGNAL[silence.target] === signal && silence.startsAt < end && silence.endsAt > start);

/** An enabled anomaly rule as the firing loop reads it. */
export interface AnomalyRule {
    channel: AlertChannel;
    comparator: Comparator;
    destination: string;
    name: string;
    ruleId: string;
    target: AnomalyTarget;
    threshold: number;
}

/** A rule's state change this pass — what a follow-up action (W7's rate limit) keys on. */
export interface AnomalyTransition {
    action: "clear" | "fire";
    reading: AnomalyReading;
    ruleId: string;
    target: AnomalyTarget;
}

/** Human label per target, for the notification. */
const ANOMALY_LABEL: Record<AnomalyTarget, string> = { error_anomaly: "Errors", usage_anomaly: "Requests" };

const formatCount = (value: number): string => Math.round(value).toLocaleString("en-US");

/** Render a fired anomaly alert: the score, and the value against what was normal. */
export const renderAnomalyAlert = (rule: Pick<AnomalyRule, "name" | "target">, reading: AnomalyReading): { body: string; subject: string } => {
    const label = ANOMALY_LABEL[rule.target];
    const direction = reading.score >= 0 ? "above" : "below";

    return {
        body:
            `${label} in the last hour on Lunora Cloud: ${formatCount(reading.value)}, against a usual ${formatCount(reading.mean)} — ` +
            `${Math.abs(reading.score).toFixed(1)} standard deviations ${direction} the rolling baseline.`,
        subject: `[Lunora] ${rule.name}: ${label.toLowerCase()} anomaly (${reading.score >= 0 ? "+" : ""}${reading.score.toFixed(1)}σ)`,
    };
};

/**
 * Evaluate every enabled anomaly rule against this pass's readings, as the same
 * level-triggered latch the metric rules use: fire on a fresh breach, clear on a
 * recovery. A rule whose signal has no reading this pass (warming up, silenced,
 * nothing new) holds its state — absence of a score is not a recovery.
 */
export const fireAnomalyRules = async <TId extends string>(
    rules: ReadonlyArray<AnomalyRule>,
    readings: Partial<Record<AnomalySignal, AnomalyReading>>,
    organizationId: string,
    ports: MetricRulePorts<TId>,
    now: number,
): Promise<{ deliveries: AlertDelivery<TId>[]; transitions: AnomalyTransition[] }> => {
    const deliveries: AlertDelivery<TId>[] = [];
    const transitions: AnomalyTransition[] = [];

    for (const rule of rules) {
        const reading = readings[ANOMALY_SIGNAL[rule.target]];

        if (reading === undefined) {
            continue;
        }

        const breaching = compareMetric(reading.score, rule.comparator, rule.threshold);
        const action = transitionFor(breaching, ports.wasFiring(rule.ruleId));

        if (action === "none") {
            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- one write per transitioning rule; small, serialized
        await ports.writeState(rule.ruleId, breaching, reading.score);
        transitions.push({ action, reading, ruleId: rule.ruleId, target: rule.target });

        if (action === "clear") {
            continue;
        }

        const rendered = renderAnomalyAlert(rule, reading);
        // eslint-disable-next-line no-await-in-loop -- one insert per fired rule; small, serialized
        const id = await ports.insertAlert({
            body: rendered.body,
            channel: rule.channel,
            createdAt: now,
            destination: rule.destination,
            hash: `${rule.target}:${ANOMALY_SIGNAL[rule.target]}`,
            organizationId,
            ruleId: rule.ruleId,
            status: "firing",
            subject: rendered.subject,
            target: rule.target,
            updatedAt: now,
        });

        deliveries.push({ body: rendered.body, channel: rule.channel, destination: rule.destination, id, subject: rendered.subject });
    }

    return { deliveries, transitions };
};
