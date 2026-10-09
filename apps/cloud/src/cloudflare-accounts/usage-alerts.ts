/**
 * Cloudflare usage alerts for a connected `cloudflare-workers` account: what
 * Cloudflare's own Usage Based Billing notifications cover on it, and the
 * thresholds Lunora Cloud proposes. Pure — the Notifications API calls live in
 * `src/cloudflare/notifications.ts` and `./alerts-api.ts`, the authorization
 * and audit in `lunora/cloudflare-alerts.ts`.
 *
 * Why Cloudflare's alerts and not ours: a project in the customer's own account
 * is billed to the customer's card, and the platform's spend cap never applies
 * there (its usage rows are `billable: false`). Cloudflare's notifications run
 * in Cloudflare, so they keep warning the customer while Lunora Cloud is down.
 *
 * Product identifiers are never guessed. Offered are the values Cloudflare
 * lists for the account (`available_alerts`), any value an existing policy
 * already stores, and the ids Cloudflare publishes for the alert type
 * ({@link PUBLISHED_PRODUCTS}). The `filters.limit` unit is not documented by
 * Cloudflare, so a proposal is a starting point the studio says it cannot
 * verify, and what Cloudflare stored is read back after every write.
 */
import type { BillingProduct, NotificationPolicy, PolicyBody } from "../cloudflare/notifications";
import { BILLING_USAGE_ALERT } from "../cloudflare/notifications";

/** The name prefix that marks a policy as Lunora-managed: one policy per product, `{prefix}{product id}`. */
export const MANAGED_POLICY_PREFIX = "Lunora Cloud usage alert: ";

/** How many times last month's usage the proposed threshold is. */
export const THRESHOLD_MULTIPLIER = 3;

/** Products one setup may write; Cloudflare's list is far shorter. */
export const MAX_ALERT_PRODUCTS = 40;

/** Recipients one setup may name. */
export const MAX_ALERT_RECIPIENTS = 10;

/** Largest threshold accepted. */
export const MAX_ALERT_LIMIT = 1e15;

/**
 * The `billing_usage_alert` product ids Cloudflare publishes — the `product`
 * filter's "Available values" in its Terraform provider's
 * `notification_policy` docs (v4.52.0). Workers requests and Durable Objects
 * only: there is no Usage Based Billing alert for D1 or Workers CPU time,
 * which only an account-wide budget alert covers.
 */
export const PUBLISHED_PRODUCTS: ReadonlyArray<BillingProduct> = [
    { description: "Workers requests", id: "worker_requests" },
    { description: "Durable Objects requests", id: "worker_durable_objects_requests" },
    { description: "Durable Objects duration", id: "worker_durable_objects_duration" },
    { description: "Durable Objects data transfer", id: "worker_durable_objects_data_transfer" },
    { description: "Durable Objects stored data", id: "worker_durable_objects_stored_data" },
    { description: "Durable Objects storage deletes", id: "worker_durable_objects_storage_deletes" },
    { description: "Durable Objects storage writes", id: "worker_durable_objects_storage_writes" },
    { description: "Durable Objects storage reads", id: "worker_durable_objects_storage_reads" },
];

/**
 * What Lunora Cloud knows about a product's usage, by product id — only where
 * the count is the same quantity the product is billed by:
 * - `floor` — the monthly amount the Workers Paid plan includes
 *   (developers.cloudflare.com/workers/platform/pricing, read 2026-10-09), the
 *   lowest proposal, so a proposal never alerts on usage that is not charged;
 * - `meter` — the `platformUsage` meter the `cloudflare-workers` readback writes
 *   for it, or `null` when the readback does not count it (Durable Object
 *   requests are not read back for connected accounts).
 *
 * The Durable Objects storage products are absent on purpose: the readback
 * counts SQLite rows, and whether Cloudflare's storage reads/writes alert
 * counts the same unit is unverified.
 */
export const PRODUCT_USAGE: Readonly<Record<string, { floor: number; meter: null | string }>> = {
    worker_durable_objects_requests: { floor: 1_000_000, meter: null },
    worker_requests: { floor: 10_000_000, meter: "requests" },
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

/** Per-meter totals of `rows` in the period starting at `periodStart`; a meter with rows but no usage totals 0. */
export const usageOfPeriod = (rows: ReadonlyArray<UsageRow>, periodStart: number): Partial<Record<string, number>> => {
    const totals: Partial<Record<string, number>> = {};

    for (const row of rows) {
        if (row.periodStart === periodStart && Number.isFinite(row.quantity) && row.quantity >= 0) {
            totals[row.kind] = (totals[row.kind] ?? 0) + row.quantity;
        }
    }

    return totals;
};

/**
 * How a proposed threshold was arrived at:
 * - `history` — {@link THRESHOLD_MULTIPLIER}× last month's read-back usage;
 * - `floor` — last month was read back and is below the included amount;
 * - `no-data` — nothing was read back for last month (no Account Analytics
 *   permission, a mid-month connection, readback lag, or a meter the readback
 *   does not count), so the included amount is only a suggestion;
 * - `unmapped` — no proposal: the customer enters a value.
 */
export type ProposalBasis = "floor" | "history" | "no-data" | "unmapped";

/** A threshold proposal for one product. */
export interface ThresholdProposal {
    basis: ProposalBasis;
    /** Last month's read-back usage; `null` when there is none to show. */
    lastMonth: null | number;
    limit: null | number;
}

/**
 * The threshold proposed for `product`. `lastMonth` holds a meter only when
 * the readback wrote rows for it in that period; `metered` says whether the
 * account's token may be read back at all (Account Analytics).
 */
export const proposeThreshold = (product: BillingProduct, lastMonth: Partial<Record<string, number>>, metered: boolean): ThresholdProposal => {
    const usage: undefined | { floor: number; meter: null | string } = Object.hasOwn(PRODUCT_USAGE, product.id) ? PRODUCT_USAGE[product.id] : undefined;

    if (usage === undefined) {
        return { basis: "unmapped", lastMonth: null, limit: null };
    }

    const used = usage.meter === null || !metered ? undefined : lastMonth[usage.meter];

    if (used === undefined) {
        return { basis: "no-data", lastMonth: null, limit: usage.floor };
    }

    const proposed = roundUpNicely(used * THRESHOLD_MULTIPLIER);

    return proposed > usage.floor ? { basis: "history", lastMonth: used, limit: proposed } : { basis: "floor", lastMonth: used, limit: usage.floor };
};

/** The managed policy name for a product. */
export const managedPolicyName = (productId: string): string => `${MANAGED_POLICY_PREFIX}${productId}`;

/** Whether `policy` is one this flow created (and may therefore replace). */
export const isManagedPolicy = (policy: Pick<NotificationPolicy, "alertType" | "name">): boolean =>
    policy.alertType === BILLING_USAGE_ALERT && policy.name.startsWith(MANAGED_POLICY_PREFIX);

/** Where the offered products came from: Cloudflare's listing for the account, or only its published ids. */
export type ProductSource = "listed" | "published";

/**
 * Every product the account may alert on: Cloudflare's listed values, any
 * value an existing Usage Based Billing policy already stores, and the
 * published ids — in that order, without repeats.
 */
export const discoverProducts = (
    listed: ReadonlyArray<BillingProduct> | null,
    policies: ReadonlyArray<NotificationPolicy>,
): { products: BillingProduct[]; source: ProductSource } => {
    const products = new Map((listed ?? []).map((product) => [product.id, product]));
    const source: ProductSource = products.size > 0 ? "listed" : "published";

    for (const policy of policies) {
        if (policy.alertType !== BILLING_USAGE_ALERT) {
            continue;
        }

        for (const id of policy.filters["product"] ?? []) {
            if (id !== "" && !products.has(id)) {
                products.set(id, PUBLISHED_PRODUCTS.find((product) => product.id === id) ?? { description: id, id });
            }
        }
    }

    for (const product of PUBLISHED_PRODUCTS) {
        if (!products.has(product.id)) {
            products.set(product.id, product);
        }
    }

    return { products: [...products.values()], source };
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

/** Orders of magnitude two thresholds may differ by before the studio warns. */
const MAGNITUDE_WARNING = 2;

/**
 * Whether `limit` differs from a threshold the customer set on their own
 * policy for the same product by {@link MAGNITUDE_WARNING} orders of magnitude
 * or more — the sign that one of the two is in another unit.
 */
export const magnitudeMismatch = (limit: number, coverage: ReadonlyArray<Pick<Coverage, "limit" | "managed">>): null | string => {
    const own = coverage.filter((policy) => !policy.managed && policy.limit !== null).map((policy) => Number(policy.limit));
    const far = own.find((value) => Number.isFinite(value) && value > 0 && limit > 0 && Math.abs(Math.log10(limit / value)) >= MAGNITUDE_WARNING);

    return far === undefined ? null : String(far);
};

/** One write a setup performs. */
export interface PolicyWrite {
    body: PolicyBody;
    /** The managed policy it replaces; absent for a new one. */
    policyId?: string;
    productId: string;
}

/** The writes for one product, and what they change. */
export interface ProductPlan {
    /** Managed policies beyond the first carrying this product's name (two setups that ran at once). */
    duplicates: number;
    /** Non-email destinations (webhooks, PagerDuty) kept from the managed policy. */
    keptDestinations: number;
    /** Addresses already on a managed policy that this setup keeps (a policy's addresses are only ever added to). */
    keptRecipients: string[];
    productId: string;
    writes: PolicyWrite[];
}

const description = (product: BillingProduct, limit: number): string =>
    `Managed by Lunora Cloud: alerts when this account's ${product.description} usage passes ${String(limit)}, as Cloudflare counts it. Update or remove it from Lunora Cloud's Cloudflare accounts tab, or here — removing it here is not undone by Lunora Cloud.`;

/**
 * The writes that make each requested product's managed policies carry its
 * threshold. A product with no managed policy gets one; every managed policy
 * already named for it is updated (two setups that ran at once leave two, and
 * both must match). An update keeps what the customer changed on the policy in
 * Cloudflare: whether it is enabled, its re-alert interval, its webhook and
 * PagerDuty destinations, and its email addresses, to which this setup's
 * recipients are added.
 * Policies the customer made are never touched.
 */
export const planPolicyWrites = (
    requests: ReadonlyArray<{ limit: number; product: BillingProduct }>,
    policies: ReadonlyArray<NotificationPolicy>,
    recipients: ReadonlyArray<string>,
): ProductPlan[] =>
    requests.map(({ limit, product }) => {
        const name = managedPolicyName(product.id);
        const managed = policies.filter((policy) => isManagedPolicy(policy) && policy.name === name);
        const fresh: PolicyBody = {
            alert_type: BILLING_USAGE_ALERT,
            description: description(product, limit),
            enabled: true,
            filters: { limit: [String(limit)], product: [product.id] },
            mechanisms: {
                email: recipients.map((address) => {
                    return { id: address };
                }),
            },
            name,
        };

        if (managed.length === 0) {
            return { duplicates: 0, keptDestinations: 0, keptRecipients: [], productId: product.id, writes: [{ body: fresh, productId: product.id }] };
        }

        const kept = new Set<string>();
        let keptDestinations = 0;
        const writes = managed.map((policy): PolicyWrite => {
            const existing = (policy.mechanisms["email"] ?? []).map((entry) => entry.id.toLowerCase());
            const emails = [...new Set([...existing, ...recipients])];

            for (const address of existing.filter((entry) => !recipients.includes(entry))) {
                kept.add(address);
            }

            const others = Object.fromEntries(Object.entries(policy.mechanisms).filter(([kind]) => kind !== "email"));

            keptDestinations = Math.max(
                keptDestinations,
                Object.values(others).reduce((sum, entries) => sum + entries.length, 0),
            );

            return {
                body: {
                    ...fresh,
                    ...(policy.alertInterval === undefined ? {} : { alert_interval: policy.alertInterval }),
                    enabled: policy.enabled,
                    mechanisms: {
                        ...others,
                        email: emails.map((address) => {
                            return { id: address };
                        }),
                    },
                },
                policyId: policy.id,
                productId: product.id,
            };
        });

        return {
            duplicates: managed.length - 1,
            keptDestinations,
            keptRecipients: [...kept].toSorted((a, b) => a.localeCompare(b, "en")),
            productId: product.id,
            writes,
        };
    });

/** Why a threshold is refused, or `null` — the one check the studio and the server share. */
export const thresholdError = (limit: number): null | string =>
    Number.isInteger(limit) && limit >= 1 && limit <= MAX_ALERT_LIMIT
        ? null
        : `a threshold must be a whole number from 1 to ${MAX_ALERT_LIMIT.toExponential()}`;

const WHITESPACE = /\s/u;

/** `Jane Doe &lt;jane@example.com>` → `jane@example.com`; anything else unchanged. */
const NAMED_ADDRESS = /<([^<>]+)>\s*$/u;

/** One `@`, something before it, and a dotted domain after it — the shape Cloudflare's email mechanism needs; delivery is Cloudflare's. */
const isAddress = (value: string): boolean => {
    const at = value.indexOf("@");
    const domain = value.slice(at + 1);

    return (
        value.length <= 320 &&
        at > 0 &&
        at === value.lastIndexOf("@") &&
        !WHITESPACE.test(value) &&
        domain.includes(".") &&
        !domain.startsWith(".") &&
        !domain.endsWith(".")
    );
};

/**
 * Recipients, each reduced to its address (`Name &lt;address>` included),
 * lowercased and deduplicated — or the first entry that is not an address, or
 * a count outside 1..{@link MAX_ALERT_RECIPIENTS}, as a message.
 */
export const normalizeRecipients = (entries: ReadonlyArray<string>): { addresses: string[] } | { error: string } => {
    const addresses: string[] = [];

    for (const entry of entries.map((value) => value.trim()).filter((value) => value !== "")) {
        const address = (NAMED_ADDRESS.exec(entry)?.[1] ?? entry).trim().toLowerCase();

        if (!isAddress(address)) {
            return { error: `"${entry.slice(0, 80)}" is not an email address` };
        }

        if (!addresses.includes(address)) {
            addresses.push(address);
        }
    }

    if (addresses.length === 0 || addresses.length > MAX_ALERT_RECIPIENTS) {
        return { error: `name 1 to ${String(MAX_ALERT_RECIPIENTS)} email addresses` };
    }

    return { addresses };
};

/** Where in Cloudflare's dashboard the customer finishes what the API cannot do. */
export const dashboardLinks = (accountId: string): { budgetAlert: string; notifications: string } => {
    return {
        budgetAlert: `https://dash.cloudflare.com/${accountId}/billing`,
        notifications: `https://dash.cloudflare.com/${accountId}/notifications`,
    };
};
