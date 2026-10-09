/**
 * The pure half of `lunora alerts setup`: given last month's usage, the
 * discovered products and the existing policies, decide which usage alerts to
 * create, update or leave alone, and at what threshold.
 */
import type { ProductOption } from "./products";
import { BILLING_ALERT_TYPE, matchProduct } from "./products";
import type { MetricId, MetricUsage } from "./usage";
import { METRICS } from "./usage";

/** Policies this command owns are recognised by this name prefix. */
const POLICY_NAME_PREFIX = "Lunora usage: ";

const DEFAULT_MULTIPLIER = 3;

/**
 * The smallest threshold proposed per metric, in the alert's unit — the monthly
 * allowance included with Workers Paid, so a quiet month never yields an alert
 * that fires on ordinary growth. Metrics whose alert unit cannot be established
 * have no floor because they never get a threshold.
 * @see https://developers.cloudflare.com/workers/platform/pricing/
 */
const FLOORS: Partial<Record<MetricId, number>> = {
    "d1-rows-read": 25_000_000_000,
    "d1-rows-written": 50_000_000,
    "do-requests": 1_000_000,
    "do-rows-read": 25_000_000_000,
    "do-rows-written": 50_000_000,
    /** Milliseconds. */
    "workers-cpu": 30_000_000,
    "workers-requests": 10_000_000,
};

/** Round up to two significant figures: 12_345_678 → 13_000_000. */
const roundUpNice = (value: number): number => {
    const whole = Math.ceil(value);

    if (whole <= 0) {
        return 0;
    }

    const step = 10 ** Math.max(0, Math.floor(Math.log10(whole)) - 1);

    return Math.ceil(whole / step) * step;
};

/** `multiplier` × `lastMonth`, rounded up, never below `floor`. Without history the floor alone. */
const thresholdFor = (lastMonth: number | undefined, multiplier: number, floor: number): { basis: "floor" | "history"; threshold: number } => {
    if (lastMonth === undefined) {
        return { basis: "floor", threshold: floor };
    }

    const scaled = roundUpNice(lastMonth * multiplier);

    return scaled > floor ? { basis: "history", threshold: scaled } : { basis: "floor", threshold: floor };
};

/** The unit a product's alert limit is in, from the option's own words. */
const MILLISECOND_UNIT = /^(?:ms|milliseconds?)$/iu;

const isMillisecondUnit = (unit: string | undefined): boolean => unit !== undefined && MILLISECOND_UNIT.test(unit.trim());

interface Mechanisms {
    email?: { id: string }[];
    webhooks?: { id: string }[];
}

interface Policy {
    alert_type?: string;
    description?: string;
    enabled?: boolean;
    filters?: Record<string, unknown>;
    id?: string;
    mechanisms?: Mechanisms & Record<string, unknown>;
    name?: string;
}

interface PolicyBody {
    alert_type: typeof BILLING_ALERT_TYPE;
    description: string;
    enabled: true;
    filters: { limit: string[]; product: string[] };
    mechanisms: Mechanisms;
    name: string;
}

interface PlannedAlert {
    action: "create" | "unchanged" | "update";
    basis: "floor" | "history";
    body: PolicyBody;
    /** Last month's reading in the metric's own unit, when there was one. */
    lastMonth: number | undefined;
    metric: MetricId;
    policyId?: string;
    product: string;
    threshold: number;
}

interface SkippedMetric {
    /** `covered`: a policy the user made already alerts on it; the rest need the dashboard. */
    kind: "covered" | "unit-unknown" | "unmatched";
    metric: MetricId;
    reason: string;
}

interface AlertPlan {
    alerts: PlannedAlert[];
    skipped: SkippedMetric[];
}

interface PlanInput {
    emails: ReadonlyArray<string>;
    multiplier: number;
    policies: ReadonlyArray<Policy>;
    products: ReadonlyArray<ProductOption>;
    usage: ReadonlyArray<MetricUsage>;
    webhooks: ReadonlyArray<string>;
}

const productsOf = (policy: Policy): string[] => {
    const product = policy.filters?.["product"];

    return Array.isArray(product) ? product.filter((id): id is string => typeof id === "string") : [];
};

const sortedIds = (list: ReadonlyArray<{ id: string }> | undefined): string =>
    (list ?? [])
        .map((entry) => entry.id)
        .toSorted((left, right) => left.localeCompare(right))
        .join(",");

/** Whether `existing` already says exactly what `body` would. */
const isSame = (existing: Policy, body: PolicyBody): boolean =>
    existing.enabled === true &&
    existing.name === body.name &&
    JSON.stringify(existing.filters?.["limit"]) === JSON.stringify(body.filters.limit) &&
    JSON.stringify(productsOf(existing)) === JSON.stringify(body.filters.product) &&
    sortedIds(existing.mechanisms?.email) === sortedIds(body.mechanisms.email) &&
    sortedIds(existing.mechanisms?.webhooks) === sortedIds(body.mechanisms.webhooks);

/** The threshold in the alert's unit, or why one cannot be set. */
const alertThreshold = (
    metric: MetricId,
    reading: MetricUsage | undefined,
    product: ProductOption,
    multiplier: number,
): { basis: "floor" | "history"; lastMonth: number | undefined; threshold: number } | { reason: string } => {
    const floor = FLOORS[metric];
    const lastMonth = reading?.status === "ok" ? reading.value : undefined;
    const unit = reading?.status === "ok" ? reading.unit : METRICS.find((definition) => definition.id === metric)?.candidates[0]?.unit;

    if (floor === undefined || unit === "unknown") {
        return { reason: "the unit Cloudflare uses for this product's alert limit is not published" };
    }

    if (unit === "count") {
        return { ...thresholdFor(lastMonth, multiplier, floor), lastMonth };
    }

    // A time total, read in microseconds: only a product that says its limit is in milliseconds can take it.
    if (!isMillisecondUnit(product.unit)) {
        return { reason: `product "${product.id}" does not state the unit of its limit, so a threshold could be off by a factor of 1000` };
    }

    return { ...thresholdFor(lastMonth === undefined ? undefined : lastMonth / 1000, multiplier, floor), lastMonth };
};

const toMechanisms = (emails: ReadonlyArray<string>, webhooks: ReadonlyArray<string>): Mechanisms => {
    const mechanisms: Mechanisms = {};

    if (emails.length > 0) {
        mechanisms.email = emails.map((id) => {
            return { id };
        });
    }

    if (webhooks.length > 0) {
        mechanisms.webhooks = webhooks.map((id) => {
            return { id };
        });
    }

    return mechanisms;
};

const actionFor = (own: Policy | undefined, body: PolicyBody): PlannedAlert["action"] => {
    if (own === undefined) {
        return "create";
    }

    return isSame(own, body) ? "unchanged" : "update";
};

const unmatchedReason = (match: Exclude<ReturnType<typeof matchProduct>, { status: "matched" }>): string =>
    match.status === "none"
        ? "no discovered product identifier names this metric"
        : `several discovered products could mean this metric (${match.candidates.join(", ")})`;

/** Decide one metric's alert, or why it gets none. */
const planOne = (
    definition: (typeof METRICS)[number],
    input: PlanInput,
    mechanisms: Mechanisms,
    billingPolicies: ReadonlyArray<Policy>,
): PlannedAlert | SkippedMetric => {
    const { id: metric, label } = definition;
    const match = matchProduct(metric, input.products);

    if (match.status !== "matched") {
        return { kind: "unmatched", metric, reason: unmatchedReason(match) };
    }

    const { product } = match;
    const covering = billingPolicies.filter((policy) => productsOf(policy).includes(product.id));
    const own = covering.find((policy) => policy.name?.startsWith(POLICY_NAME_PREFIX) === true);
    const foreign = covering.find((policy) => policy.name?.startsWith(POLICY_NAME_PREFIX) !== true);

    if (own === undefined && foreign !== undefined) {
        return { kind: "covered", metric, reason: `already alerted by the existing policy "${foreign.name ?? foreign.id ?? "?"}"` };
    }

    const decided = alertThreshold(
        metric,
        input.usage.find((reading) => reading.id === metric),
        product,
        input.multiplier,
    );

    if ("reason" in decided) {
        return { kind: "unit-unknown", metric, reason: decided.reason };
    }

    const basis = decided.basis === "history" ? `${String(input.multiplier)}× last month` : "the included monthly allowance (floor)";
    const body: PolicyBody = {
        alert_type: BILLING_ALERT_TYPE,
        description: `Managed by \`lunora alerts setup\`: ${basis}.`,
        enabled: true,
        filters: { limit: [String(decided.threshold)], product: [product.id] },
        mechanisms,
        name: `${POLICY_NAME_PREFIX}${label}`,
    };

    return {
        action: actionFor(own, body),
        basis: decided.basis,
        body,
        lastMonth: decided.lastMonth,
        metric,
        ...(own?.id === undefined ? {} : { policyId: own.id }),
        product: product.id,
        threshold: decided.threshold,
    };
};

/** Decide every alert. Pure: the same input always yields the same plan. */
const planAlerts = (input: PlanInput): AlertPlan => {
    const mechanisms = toMechanisms(input.emails, input.webhooks);
    const billingPolicies = input.policies.filter((policy) => policy.alert_type === BILLING_ALERT_TYPE);
    const plan: AlertPlan = { alerts: [], skipped: [] };

    for (const definition of METRICS) {
        const decided = planOne(definition, input, mechanisms, billingPolicies);

        if ("action" in decided) {
            plan.alerts.push(decided);
        } else {
            plan.skipped.push(decided);
        }
    }

    return plan;
};

export type { AlertPlan, Mechanisms, PlanInput, PlannedAlert, Policy, PolicyBody, SkippedMetric };
export { DEFAULT_MULTIPLIER, FLOORS, planAlerts, POLICY_NAME_PREFIX, roundUpNice, thresholdFor };
