/**
 * The pure half of `lunora alerts setup`: given last month's usage, the
 * products and the existing policies, decide which usage alerts to create,
 * update or leave alone, and at what threshold.
 */
import type { ProductOption } from "./products";
import { BILLING_ALERT_TYPE, matchProduct } from "./products";
import type { MetricId, MetricUsage } from "./usage";
import { METRICS } from "./usage";

/** Policies this command owns are named `<prefix><metric label>`. */
const POLICY_NAME_PREFIX = "Lunora usage: ";

const DEFAULT_MULTIPLIER = 3;

/**
 * Cloudflare does not document the unit of a usage alert's `limit`. Shown in
 * every plan and carried in the JSON output.
 */
const LIMIT_UNIT_CAVEAT =
    "Cloudflare does not document the unit of a usage alert's limit; limits are sent as plain request counts. Check the stored limit in the dashboard.";

/**
 * The metrics whose threshold is derived automatically, with the smallest one
 * proposed — the monthly allowance included with Workers Paid. Only request
 * counts qualify: a request is a request in the GraphQL dataset and in the
 * billing product alike. Every other metric's product is metered in a unit
 * that cannot be matched to an analytics field (Durable Objects duration in
 * GB-s, storage reads/writes vs. SQLite rows), so it takes `--threshold`.
 * @see https://developers.cloudflare.com/workers/platform/pricing/
 */
const FLOORS: Partial<Record<MetricId, number>> = {
    "do-requests": 1_000_000,
    "workers-requests": 10_000_000,
};

/** Order-of-magnitude gap, between a planned limit and a user-made one, worth a warning. */
const MAGNITUDE_WARNING_RATIO = 100;

/** Round up to two significant figures: 12_345_678 → 13_000_000. */
const roundUpNice = (value: number): number => {
    const whole = Math.ceil(value);

    if (whole <= 0) {
        return 0;
    }

    const step = 10 ** Math.max(0, Math.floor(Math.log10(whole)) - 1);

    return Math.ceil(whole / step) * step;
};

/** `multiplier` × `lastMonth`, rounded up, never below `floor`. */
const thresholdFor = (lastMonth: number, multiplier: number, floor: number): { basis: "floor" | "history"; threshold: number } => {
    const scaled = roundUpNice(lastMonth * multiplier);

    return scaled > floor ? { basis: "history", threshold: scaled } : { basis: "floor", threshold: floor };
};

/**
 * Where a threshold came from. `floor` is a real reading below the floor
 * (including zero); `floor-usage-unavailable` is the floor because usage could
 * not be read at all, applied only on `--allow-floor`.
 */
type Basis = "explicit" | "floor" | "floor-usage-unavailable" | "history";

/** Delivery targets by kind (`email`, `webhooks`, `pagerduty`, …). */
type Mechanisms = Record<string, ReadonlyArray<{ id: string }>>;

interface Policy {
    alert_type?: string;
    description?: string;
    enabled?: boolean;
    filters?: Record<string, unknown>;
    id?: string;
    mechanisms?: Record<string, unknown>;
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
    basis: Basis;
    body: PolicyBody;
    /** Last month's reading, when there was one. */
    lastMonth: number | undefined;
    metric: MetricId;
    policyId?: string;
    /** The product the existing policy named, when this update changes it. */
    previousProduct?: string[];
    product: string;
    productSource: ProductOption["source"];
    /** Delivery targets added and removed, as `kind:id`. */
    recipients: { added: string[]; removed: string[] };
    threshold: number;
}

interface SkippedMetric {
    /**
     * `covered`: an enabled policy the user made already alerts on it.
     * `no-product`: Cloudflare has no usage alert for it.
     * `ambiguous`: several offered products could mean it.
     * `unit-unverified`: its product's unit cannot be matched to the usage reading.
     * `usage-unavailable`: last month's usage could not be read.
     */
    kind: "ambiguous" | "covered" | "no-product" | "unit-unverified" | "usage-unavailable";
    metric: MetricId;
    reason: string;
    /** A planned/user-made limit mismatch large enough to suggest a unit problem. */
    warning?: string;
}

interface AlertPlan {
    alerts: PlannedAlert[];
    /** Extra policies sharing an owned name — left alone, reported. */
    duplicates: Policy[];
    /** `Lunora usage: …` policies naming no current metric — left alone, reported. */
    orphans: Policy[];
    skipped: SkippedMetric[];
}

interface PlanInput {
    /** Apply the floor when usage could not be read. */
    allowFloor?: boolean;
    emails: ReadonlyArray<string>;
    multiplier: number;
    policies: ReadonlyArray<Policy>;
    products: ReadonlyArray<ProductOption>;
    /** Replace an updated policy's delivery targets instead of adding to them. */
    replaceRecipients?: boolean;
    /** `--threshold <metric>=<n>`: the user's own limit, in the product's unit. */
    thresholds?: Partial<Record<MetricId, number>>;
    usage: ReadonlyArray<MetricUsage>;
    webhooks: ReadonlyArray<string>;
}

const productsOf = (policy: Policy): string[] => {
    const product = policy.filters?.["product"];

    return Array.isArray(product) ? product.filter((id): id is string => typeof id === "string") : [];
};

const limitOf = (policy: Policy): number | undefined => {
    const limit = policy.filters?.["limit"];
    const first: unknown = Array.isArray(limit) ? limit[0] : undefined;
    const value = typeof first === "string" ? Number(first) : Number.NaN;

    return Number.isFinite(value) ? value : undefined;
};

/** The well-formed `{ id }` lists of a stored `mechanisms` object. */
const mechanismsOf = (policy: Policy | undefined): Mechanisms => {
    const out: Record<string, { id: string }[]> = {};

    for (const [kind, list] of Object.entries(policy?.mechanisms ?? {})) {
        if (Array.isArray(list)) {
            out[kind] = list.filter(
                (entry: unknown): entry is { id: string } => typeof entry === "object" && entry !== null && "id" in entry && typeof entry.id === "string",
            );
        }
    }

    return out;
};

/** Every target in both, de-duplicated per kind; `existing` first. */
const mergeMechanisms = (existing: Mechanisms, wanted: Mechanisms): Mechanisms => {
    const out: Record<string, { id: string }[]> = {};

    for (const [kind, list] of [...Object.entries(existing), ...Object.entries(wanted)]) {
        const seen = new Set((out[kind] ?? []).map((entry) => entry.id));

        out[kind] = [...(out[kind] ?? []), ...list.filter((entry) => !seen.has(entry.id))];
    }

    return Object.fromEntries(Object.entries(out).filter(([, list]) => list.length > 0));
};

const flatTargets = (mechanisms: Mechanisms): string[] => Object.entries(mechanisms).flatMap(([kind, list]) => list.map((entry) => `${kind}:${entry.id}`));

const sameTargets = (left: Mechanisms, right: Mechanisms): boolean =>
    JSON.stringify(flatTargets(left).toSorted((a, b) => a.localeCompare(b))) === JSON.stringify(flatTargets(right).toSorted((a, b) => a.localeCompare(b)));

/** Whether `existing` already says exactly what `body` would. */
const isSame = (existing: Policy, body: PolicyBody): boolean =>
    existing.enabled === true &&
    existing.name === body.name &&
    JSON.stringify(existing.filters?.["limit"]) === JSON.stringify(body.filters.limit) &&
    JSON.stringify(productsOf(existing)) === JSON.stringify(body.filters.product) &&
    sameTargets(mechanismsOf(existing), body.mechanisms);

const toMechanisms = (emails: ReadonlyArray<string>, webhooks: ReadonlyArray<string>): Mechanisms => {
    const mechanisms: Record<string, { id: string }[]> = {};

    if (emails.length > 0) {
        mechanisms["email"] = emails.map((id) => {
            return { id };
        });
    }

    if (webhooks.length > 0) {
        mechanisms["webhooks"] = webhooks.map((id) => {
            return { id };
        });
    }

    return mechanisms;
};

type Threshold = { basis: Basis; lastMonth: number | undefined; threshold: number };

/** The threshold for a metric, or why it gets none. */
const decideThreshold = (metric: MetricId, product: ProductOption, input: PlanInput): Threshold | Pick<SkippedMetric, "kind" | "reason"> => {
    const explicit = input.thresholds?.[metric];
    const reading = input.usage.find((entry) => entry.id === metric);
    const lastMonth = reading?.status === "ok" ? reading.value : undefined;

    if (explicit !== undefined) {
        return { basis: "explicit", lastMonth, threshold: explicit };
    }

    const floor = FLOORS[metric];

    if (floor === undefined) {
        return {
            kind: "unit-unverified",
            reason: `the unit Cloudflare meters "${product.id}" in is not documented and cannot be matched to the usage reading; set one yourself with --threshold ${metric}=<n>`,
        };
    }

    if (lastMonth !== undefined) {
        return { ...thresholdFor(lastMonth, input.multiplier, floor), lastMonth };
    }

    if (input.allowFloor === true) {
        return { basis: "floor-usage-unavailable", lastMonth: undefined, threshold: floor };
    }

    const why = reading?.status === "unavailable" ? reading.reason : "no reading";

    return {
        kind: "usage-unavailable",
        reason: `last month's usage could not be read (${why}), and an alert at the floor could fire every month on an account that already exceeds it; pass --threshold ${metric}=<n>, or --allow-floor`,
    };
};

/** A >100× gap between a planned limit and a user-made one is worth a warning: the unit is undocumented. */
const magnitudeWarning = (foreign: Policy, planned: number | undefined): string | undefined => {
    const theirs = limitOf(foreign);

    if (theirs === undefined || planned === undefined || theirs <= 0 || planned <= 0) {
        return undefined;
    }

    const ratio = Math.max(theirs / planned, planned / theirs);

    return ratio >= MAGNITUDE_WARNING_RATIO
        ? `its limit ${String(theirs)} differs from the ${String(planned)} this would plan by ${String(Math.round(ratio))}× — one of the two may be in the wrong unit`
        : undefined;
};

const ownName = (label: string): string => `${POLICY_NAME_PREFIX}${label}`;

const actionFor = (own: Policy | undefined, body: PolicyBody): PlannedAlert["action"] => {
    if (own === undefined) {
        return "create";
    }

    return isSame(own, body) ? "unchanged" : "update";
};

const describeBasis = (basis: Basis, multiplier: number): string => {
    switch (basis) {
        case "explicit": {
            return "set with --threshold";
        }
        case "floor-usage-unavailable": {
            return "the included monthly allowance, applied with --allow-floor because usage could not be read";
        }
        case "history": {
            return `${String(multiplier)}× last month`;
        }
        default: {
            return "the included monthly allowance (floor)";
        }
    }
};

/** Decide one metric's alert, or why it gets none. */
const planOne = (definition: (typeof METRICS)[number], input: PlanInput, billingPolicies: ReadonlyArray<Policy>): PlannedAlert | SkippedMetric => {
    const { id: metric, label } = definition;
    const match = matchProduct(metric, input.products);

    if (match.status === "no-product") {
        return { kind: "no-product", metric, reason: "Cloudflare has no usage alert for this product; the account-wide budget alert is its guard" };
    }

    if (match.status === "ambiguous") {
        return { kind: "ambiguous", metric, reason: `several offered products could mean this metric (${match.candidates.join(", ")})` };
    }

    const { product } = match;
    // Owned by exact name, so a product change updates the policy instead of orphaning it.
    const own = billingPolicies.find((policy) => policy.name === ownName(label));
    const foreign = billingPolicies.find(
        (policy) => policy.enabled === true && policy.name?.startsWith(POLICY_NAME_PREFIX) !== true && productsOf(policy).includes(product.id),
    );
    const decided = decideThreshold(metric, product, input);

    if (own === undefined && foreign !== undefined) {
        const warning = magnitudeWarning(foreign, "threshold" in decided ? decided.threshold : undefined);

        return {
            kind: "covered",
            metric,
            reason: `already alerted by the existing policy "${foreign.name ?? foreign.id ?? "?"}"`,
            ...(warning === undefined ? {} : { warning }),
        };
    }

    if (!("threshold" in decided)) {
        return { ...decided, metric };
    }

    const wanted = toMechanisms(input.emails, input.webhooks);
    const before = mechanismsOf(own);
    const mechanisms = own === undefined || input.replaceRecipients === true ? wanted : mergeMechanisms(before, wanted);
    const beforeTargets = new Set(flatTargets(before));
    const afterTargets = new Set(flatTargets(mechanisms));
    const body: PolicyBody = {
        alert_type: BILLING_ALERT_TYPE,
        description: `Managed by \`lunora alerts setup\`: ${describeBasis(decided.basis, input.multiplier)}.`,
        enabled: true,
        filters: { limit: [String(decided.threshold)], product: [product.id] },
        mechanisms,
        name: ownName(label),
    };
    const previous = own === undefined ? [] : productsOf(own);

    return {
        action: actionFor(own, body),
        basis: decided.basis,
        body,
        lastMonth: decided.lastMonth,
        metric,
        ...(own?.id === undefined ? {} : { policyId: own.id }),
        ...(own !== undefined && JSON.stringify(previous) !== JSON.stringify([product.id]) ? { previousProduct: previous } : {}),
        product: product.id,
        productSource: product.source,
        recipients: {
            added: [...afterTargets].filter((target) => !beforeTargets.has(target)),
            removed: [...beforeTargets].filter((target) => !afterTargets.has(target)),
        },
        threshold: decided.threshold,
    };
};

/** Decide every alert. Pure: the same input always yields the same plan. */
const planAlerts = (input: PlanInput): AlertPlan => {
    const billingPolicies = input.policies.filter((policy) => policy.alert_type === BILLING_ALERT_TYPE);
    const ownNames = new Set(METRICS.map((definition) => ownName(definition.label)));
    const plan: AlertPlan = {
        alerts: [],
        duplicates: [],
        orphans: billingPolicies.filter((policy) => policy.name?.startsWith(POLICY_NAME_PREFIX) === true && !ownNames.has(policy.name)),
        skipped: [],
    };

    for (const name of ownNames) {
        plan.duplicates.push(...billingPolicies.filter((policy) => policy.name === name).slice(1));
    }

    for (const definition of METRICS) {
        const decided = planOne(definition, input, billingPolicies);

        if ("action" in decided) {
            plan.alerts.push(decided);
        } else {
            plan.skipped.push(decided);
        }
    }

    return plan;
};

export type { AlertPlan, Basis, Mechanisms, PlanInput, PlannedAlert, Policy, PolicyBody, SkippedMetric };
export { DEFAULT_MULTIPLIER, FLOORS, LIMIT_UNIT_CAVEAT, mechanismsOf, planAlerts, POLICY_NAME_PREFIX, roundUpNice, thresholdFor };
