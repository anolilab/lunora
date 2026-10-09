/**
 * Cloudflare usage alerts for a connected `cloudflare-workers` account: what
 * Cloudflare's own Usage Based Billing notifications cover on it, and the
 * thresholds Lunora Cloud proposes. Pure — the Notifications API calls live in
 * `src/cloudflare/notifications.ts`, the authorization and audit in
 * `lunora/cloudflare-alerts.ts`.
 *
 * Why Cloudflare's alerts and not ours: a project in the customer's own account
 * is billed to the customer's card, and the platform's spend cap never applies
 * there (its usage rows are `billable: false`). Cloudflare's notifications run
 * in Cloudflare, so they keep warning the customer while Lunora Cloud is down.
 *
 * Product identifiers are never guessed. Only the values Cloudflare lists for
 * the account (`available_alerts`) or already stores on one of its policies are
 * offered; when there are none, nothing is created and the customer is pointed
 * at the dashboard instead.
 */
import type { BillingProduct, NotificationPolicy, PolicyBody } from "../cloudflare/notifications";
import { BILLING_USAGE_ALERT } from "../cloudflare/notifications";

/** The name prefix that marks a policy as Lunora-managed: one policy per product, `{prefix}{product id}`. */
export const MANAGED_POLICY_PREFIX = "Lunora Cloud usage alert: ";

/** How many times last month's usage the proposed threshold is. */
export const THRESHOLD_MULTIPLIER = 3;

/** Products one setup may write; Cloudflare's list is far shorter. */
export const MAX_ALERT_PRODUCTS = 40;

/** Recipients one policy may name. */
export const MAX_ALERT_RECIPIENTS = 10;

/** Largest threshold accepted. */
export const MAX_ALERT_LIMIT = 1e15;

/** The meters a product can be matched to — the ones the `cloudflare-workers` readback writes, plus a few with a known floor. */
export type AlertMeter =
    | "d1RowsRead"
    | "d1RowsWritten"
    | "doRequests"
    | "doRowsRead"
    | "doRowsWritten"
    | "kvReads"
    | "kvWrites"
    | "queueOperations"
    | "r2ClassAOps"
    | "r2ClassBOps"
    | "requests";

/**
 * The lowest threshold proposed per meter: the monthly quantity the Workers
 * Paid plan includes (developers.cloudflare.com/workers/platform/pricing and
 * /r2/pricing, read 2026-10-09), so a proposal never alerts on usage the
 * customer is not charged for. "Well above normal" is the multiplier's job; this keeps a
 * nearly idle account from being alerted at a few hundred requests.
 */
export const METER_FLOORS: Readonly<Record<AlertMeter, number>> = {
    d1RowsRead: 25_000_000_000,
    d1RowsWritten: 50_000_000,
    doRequests: 1_000_000,
    doRowsRead: 25_000_000_000,
    doRowsWritten: 50_000_000,
    kvReads: 10_000_000,
    kvWrites: 1_000_000,
    queueOperations: 1_000_000,
    r2ClassAOps: 1_000_000,
    r2ClassBOps: 10_000_000,
    requests: 10_000_000,
};

/**
 * How a discovered product is matched to a meter: by Cloudflare's own name for
 * it (and its id), most specific first — a Durable Objects request is not a
 * Workers request. A product matching none gets no proposed threshold; the
 * customer types one or leaves it out.
 */
const METER_MATCHERS: ReadonlyArray<{ meter: AlertMeter; patterns: RegExp[] }> = [
    { meter: "doRowsRead", patterns: [/durable.?objects?/u, /rows?.?read/u] },
    { meter: "doRowsWritten", patterns: [/durable.?objects?/u, /rows?.?writ/u] },
    { meter: "doRequests", patterns: [/durable.?objects?/u, /request/u] },
    { meter: "d1RowsRead", patterns: [/\bd1\b/u, /rows?.?read/u] },
    { meter: "d1RowsWritten", patterns: [/\bd1\b/u, /rows?.?writ/u] },
    { meter: "kvReads", patterns: [/\bkv\b|key.?value/u, /read/u] },
    { meter: "kvWrites", patterns: [/\bkv\b|key.?value/u, /writ/u] },
    { meter: "r2ClassAOps", patterns: [/\br2\b/u, /class.?a\b/u] },
    { meter: "r2ClassBOps", patterns: [/\br2\b/u, /class.?b\b/u] },
    { meter: "queueOperations", patterns: [/queue/u, /operation/u] },
    { meter: "requests", patterns: [/workers?/u, /request/u] },
];

/** The meter a product's usage is counted in, or `null` when its name matches none. */
export const meterFor = (product: BillingProduct): AlertMeter | null => {
    const text = `${product.id} ${product.description}`.toLowerCase().replaceAll("_", " ");

    return METER_MATCHERS.find((matcher) => matcher.patterns.every((pattern) => pattern.test(text)))?.meter ?? null;
};

/** Round up to the next 1, 2 or 5 × 10ⁿ, so a threshold reads as a number someone chose. */
export const roundUpNicely = (value: number): number => {
    if (!Number.isFinite(value) || value <= 1) {
        return 1;
    }

    const magnitude = 10 ** Math.floor(Math.log10(value));
    const step = [1, 2, 5, 10].find((candidate) => candidate * magnitude >= value) ?? 10;

    return step * magnitude;
};

/** The first instant (epoch ms, UTC) of the month before the one `now` falls in. */
export const previousPeriodStart = (now: number): number => {
    const date = new Date(now);

    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1);
};

/** A `platformUsage` row, as much of it as the history needs. */
export interface UsageRow {
    kind: string;
    periodStart: number;
    quantity: number;
}

/** Per-meter totals of `rows` in the period starting at `periodStart`. */
export const usageOfPeriod = (rows: ReadonlyArray<UsageRow>, periodStart: number): Partial<Record<string, number>> => {
    const totals: Partial<Record<string, number>> = {};

    for (const row of rows) {
        if (row.periodStart === periodStart && Number.isFinite(row.quantity) && row.quantity > 0) {
            totals[row.kind] = (totals[row.kind] ?? 0) + row.quantity;
        }
    }

    return totals;
};

/** How a proposed threshold was arrived at. */
export type ProposalBasis = "floor" | "history" | "unmapped";

/** A threshold proposal for one product. */
export interface ThresholdProposal {
    basis: ProposalBasis;
    /** Last month's usage on the meter, from the Lunora projects in the account; `null` when the product maps to no meter. */
    lastMonth: null | number;
    limit: null | number;
    meter: AlertMeter | null;
}

/**
 * The threshold proposed for `product`: {@link THRESHOLD_MULTIPLIER}× last
 * month's usage, rounded up, never below the meter's floor; the floor alone
 * when there is no history; nothing when the product maps to no meter.
 */
export const proposeThreshold = (product: BillingProduct, lastMonth: Partial<Record<string, number>>): ThresholdProposal => {
    const meter = meterFor(product);

    if (meter === null) {
        return { basis: "unmapped", lastMonth: null, limit: null, meter: null };
    }

    const used = lastMonth[meter] ?? 0;
    const floor = METER_FLOORS[meter];

    if (used <= 0) {
        return { basis: "floor", lastMonth: 0, limit: floor, meter };
    }

    const proposed = roundUpNicely(used * THRESHOLD_MULTIPLIER);

    return proposed > floor ? { basis: "history", lastMonth: used, limit: proposed, meter } : { basis: "floor", lastMonth: used, limit: floor, meter };
};

/** The managed policy name for a product. */
export const managedPolicyName = (productId: string): string => `${MANAGED_POLICY_PREFIX}${productId}`;

/** Whether `policy` is one this flow created (and may therefore replace). */
export const isManagedPolicy = (policy: Pick<NotificationPolicy, "alertType" | "name">): boolean =>
    policy.alertType === BILLING_USAGE_ALERT && policy.name.startsWith(MANAGED_POLICY_PREFIX);

/**
 * Every product the account may alert on: Cloudflare's listed values, plus any
 * value an existing Usage Based Billing policy already stores (a real
 * identifier, set from the dashboard), in Cloudflare's order.
 */
export const discoverProducts = (listed: ReadonlyArray<BillingProduct> | null, policies: ReadonlyArray<NotificationPolicy>): BillingProduct[] => {
    const products = new Map((listed ?? []).map((product) => [product.id, product]));

    for (const policy of policies) {
        if (policy.alertType !== BILLING_USAGE_ALERT) {
            continue;
        }

        for (const id of policy.filters["product"] ?? []) {
            if (id !== "" && !products.has(id)) {
                products.set(id, { description: id, id });
            }
        }
    }

    return [...products.values()];
};

/** A Usage Based Billing policy covering a product. */
export interface Coverage {
    enabled: boolean;
    /** Its threshold, when the policy stores exactly one. */
    limit: null | string;
    managed: boolean;
    name: string;
    policyId: string;
}

/** The Usage Based Billing policies covering each product id. */
export const coverageByProduct = (policies: ReadonlyArray<NotificationPolicy>): Map<string, Coverage[]> => {
    const covered = new Map<string, Coverage[]>();

    for (const policy of policies) {
        if (policy.alertType !== BILLING_USAGE_ALERT) {
            continue;
        }

        const limits = policy.filters["limit"] ?? [];

        for (const product of policy.filters["product"] ?? []) {
            const entry: Coverage = {
                enabled: policy.enabled,
                limit: limits.length === 1 ? (limits[0] ?? null) : null,
                managed: isManagedPolicy(policy),
                name: policy.name,
                policyId: policy.id,
            };

            covered.set(product, [...(covered.get(product) ?? []), entry]);
        }
    }

    return covered;
};

/** One write a setup performs. */
export interface PolicyWrite {
    body: PolicyBody;
    /** The managed policy it replaces; absent for a new one. */
    policyId?: string;
    productId: string;
}

/**
 * The writes that make each requested product carry exactly one managed policy
 * at its threshold, to these recipients: a replacement of the managed policy
 * already there (so running setup twice never duplicates one), a create
 * otherwise. Policies the customer made are never touched.
 */
export const planPolicyWrites = (
    requests: ReadonlyArray<{ limit: number; product: BillingProduct }>,
    policies: ReadonlyArray<NotificationPolicy>,
    recipients: ReadonlyArray<string>,
): PolicyWrite[] => {
    const managed = new Map(policies.filter((policy) => isManagedPolicy(policy)).map((policy) => [policy.name, policy.id]));

    return requests.map(({ limit, product }) => {
        const name = managedPolicyName(product.id);
        const policyId = managed.get(name);
        const body: PolicyBody = {
            alert_type: BILLING_USAGE_ALERT,
            description: `Managed by Lunora Cloud: emails when this account's ${product.description} usage passes ${String(limit)} in a billing period. Edit or remove it from Lunora Cloud's Cloudflare accounts tab.`,
            enabled: true,
            filters: { limit: [String(limit)], product: [product.id] },
            mechanisms: {
                email: recipients.map((address) => {
                    return { id: address };
                }),
            },
            name,
        };

        return { body, productId: product.id, ...(policyId === undefined ? {} : { policyId }) };
    });
};

const WHITESPACE = /\s/u;

/** One `@`, something before it, and a dotted domain after it — the shape Cloudflare's email mechanism needs; delivery is Cloudflare's. */
const isAddress = (value: string): boolean => {
    const at = value.indexOf("@");
    const domain = value.slice(at + 1);

    return at > 0 && at === value.lastIndexOf("@") && !WHITESPACE.test(value) && domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
};

/** Recipients, trimmed, lowercased and deduplicated; `null` when one is not an address or there are too many or none. */
export const normalizeRecipients = (addresses: ReadonlyArray<string>): null | string[] => {
    const unique = [...new Set(addresses.map((address) => address.trim().toLowerCase()).filter((address) => address !== ""))];

    if (unique.length === 0 || unique.length > MAX_ALERT_RECIPIENTS || unique.some((address) => address.length > 320 || !isAddress(address))) {
        return null;
    }

    return unique;
};

/** Where in Cloudflare's dashboard the customer finishes what the API cannot do. */
export const dashboardLinks = (accountId: string): { budgetAlert: string; notifications: string } => {
    return {
        budgetAlert: `https://dash.cloudflare.com/${accountId}/billing`,
        notifications: `https://dash.cloudflare.com/${accountId}/notifications`,
    };
};
