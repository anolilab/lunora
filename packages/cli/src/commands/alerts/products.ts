/**
 * Which `product` values a Usage Based Billing notification (`billing_usage_alert`)
 * accepts on this account, discovered — never assumed.
 *
 * Cloudflare does not publish the product identifiers. Two sources are read:
 * the `filter_options` that `GET /alerting/v3/available_alerts` returns for the
 * alert type (typed only as `unknown[]` in Cloudflare's own SDK, so it is walked
 * defensively), and the `filters.product` of policies already on the account
 * (for instance ones made in the dashboard). A product is then tied to a metric
 * only when its identifier or label names that metric unambiguously.
 */
import type { MetricId } from "./usage";

const BILLING_ALERT_TYPE = "billing_usage_alert";

interface ProductOption {
    id: string;
    label?: string;
    source: "available-alerts" | "existing-policy";
    /** The unit the option states for its limit, when it states one. */
    unit?: string;
}

interface ProductDiscovery {
    /**
     * Whether the account may create the alert type: `false` when the list of
     * alert types it is eligible for omits it, `undefined` when that list could
     * not be read.
     */
    eligible: boolean | undefined;
    products: ProductOption[];
}

const MAX_DEPTH = 6;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const firstString = (record: Record<string, unknown>, keys: ReadonlyArray<string>): string | undefined => {
    for (const key of keys) {
        const value = record[key];

        if (typeof value === "string" && value.length > 0) {
            return value;
        }
    }

    return undefined;
};

/** One entry of a product value list: a bare string, or an object naming its value. */
const productFromEntry = (entry: unknown): ProductOption | undefined => {
    if (typeof entry === "string" && entry.length > 0) {
        return { id: entry, source: "available-alerts" };
    }

    const record = asRecord(entry);
    const id = record === undefined ? undefined : firstString(record, ["value", "id", "key", "name"]);

    if (record === undefined || id === undefined) {
        return undefined;
    }

    const label = firstString(record, ["label", "display_name", "displayName", "description", "name"]);
    const unit = firstString(record, ["unit", "units", "limit_unit"]);

    return { id, source: "available-alerts", ...(label === undefined || label === id ? {} : { label }), ...(unit === undefined ? {} : { unit }) };
};

const VALUE_LIST_KEYS = ["values", "options", "available_values", "enum", "choices"] as const;

const toOptions = (list: ReadonlyArray<unknown>): ProductOption[] =>
    list.map((entry) => productFromEntry(entry)).filter((option): option is ProductOption => option !== undefined);

/** The value lists of a `{ key: "product", values: [...] }`-shaped record (and its spellings), else nothing. */
const listedProducts = (record: Record<string, unknown>): ProductOption[] => {
    if (firstString(record, ["key", "name", "filter", "id"]) !== "product") {
        return [];
    }

    return VALUE_LIST_KEYS.flatMap((key) => {
        const list = record[key];

        return Array.isArray(list) ? toOptions(list) : [];
    });
};

/** Collect product options from anywhere inside `node` that is clearly labelled `product`. */
const collectProducts = (node: unknown, depth: number, out: ProductOption[]): void => {
    if (depth > MAX_DEPTH) {
        return;
    }

    if (Array.isArray(node)) {
        for (const item of node) {
            collectProducts(item, depth + 1, out);
        }

        return;
    }

    const record = asRecord(node);

    if (record === undefined) {
        return;
    }

    out.push(...listedProducts(record));

    for (const [key, value] of Object.entries(record)) {
        // `{ product: [...] }`
        if (key === "product" && Array.isArray(value)) {
            out.push(...toOptions(value));
        } else if (typeof value === "object" && value !== null) {
            collectProducts(value, depth + 1, out);
        }
    }
};

/** The `billing_usage_alert` entry of an `available_alerts` result (a map of category → alert types). */
const findBillingAlertType = (availableAlerts: unknown): Record<string, unknown> | undefined => {
    const categories = asRecord(availableAlerts);

    if (categories === undefined) {
        return undefined;
    }

    for (const items of Object.values(categories)) {
        if (Array.isArray(items)) {
            const match = items.map((item) => asRecord(item)).find((item) => item?.["type"] === BILLING_ALERT_TYPE);

            if (match !== undefined) {
                return match;
            }
        }
    }

    return undefined;
};

/** The product ids stored on the account's existing usage-alert policies. */
const productsFromPolicies = (policies: ReadonlyArray<{ alert_type?: string; filters?: { product?: unknown } }>): ProductOption[] =>
    policies
        .filter((policy) => policy.alert_type === BILLING_ALERT_TYPE && Array.isArray(policy.filters?.product))
        .flatMap((policy) => (policy.filters?.product as unknown[]).filter((id): id is string => typeof id === "string" && id.length > 0))
        .map((id) => {
            return { id, source: "existing-policy" as const };
        });

/**
 * Combine both sources, keeping the richer `available_alerts` entry when the
 * same id shows up in both.
 */
const discoverProducts = (
    availableAlerts: unknown,
    availableAlertsRead: boolean,
    policies: ReadonlyArray<{ alert_type?: string; filters?: { product?: unknown } }>,
): ProductDiscovery => {
    const alertType = findBillingAlertType(availableAlerts);
    const fromOptions: ProductOption[] = [];

    if (alertType !== undefined) {
        collectProducts(alertType["filter_options"], 0, fromOptions);
    }

    const byId = new Map<string, ProductOption>();

    for (const option of [...fromOptions, ...productsFromPolicies(policies)]) {
        if (!byId.has(option.id)) {
            byId.set(option.id, option);
        }
    }

    return { eligible: availableAlertsRead ? alertType !== undefined : undefined, products: [...byId.values()] };
};

const NON_ALPHANUMERIC = /[^a-z\d]+/u;

/** The lower-cased words of a product's id and label. */
const wordsOf = (option: ProductOption): string[] =>
    `${option.id} ${option.label ?? ""}`
        .toLowerCase()
        .split(NON_ALPHANUMERIC)
        .filter((word) => word.length > 0);

/**
 * What a product's id or label must say to stand for each metric: a word
 * starting with one of the alternatives in every `all` group, and no word
 * starting with anything in `none`.
 */
const MATCHERS: Record<MetricId, { all: ReadonlyArray<ReadonlyArray<string>>; none?: ReadonlyArray<string> }> = {
    "d1-rows-read": { all: [["d1"], ["read"]] },
    "d1-rows-written": { all: [["d1"], ["writ"]] },
    "do-duration": { all: [["durable"], ["duration", "gb"]] },
    "do-requests": { all: [["durable"], ["request"]] },
    "do-rows-read": { all: [["durable"], ["read"]], none: ["request"] },
    "do-rows-written": { all: [["durable"], ["writ"]] },
    "workers-cpu": { all: [["worker"], ["cpu"]], none: ["durable"] },
    "workers-requests": { all: [["worker"], ["request"]], none: ["durable", "cpu", "kv", "d1"] },
};

const namesMetric = (metric: MetricId, option: ProductOption): boolean => {
    const words = wordsOf(option);
    const has = (prefix: string): boolean => words.some((word) => word.startsWith(prefix));
    const { all, none = [] } = MATCHERS[metric];

    return all.every((group) => group.some((prefix) => has(prefix))) && !none.some((prefix) => has(prefix));
};

type ProductMatch = { product: ProductOption; status: "matched" } | { candidates: string[]; status: "ambiguous" } | { status: "none" };

/** The one discovered product that names `metric`, if exactly one does. */
const matchProduct = (metric: MetricId, products: ReadonlyArray<ProductOption>): ProductMatch => {
    const matches = products.filter((product) => namesMetric(metric, product));

    if (matches.length === 1 && matches[0] !== undefined) {
        return { product: matches[0], status: "matched" };
    }

    return matches.length === 0 ? { status: "none" } : { candidates: matches.map((product) => product.id), status: "ambiguous" };
};

export type { ProductDiscovery, ProductMatch, ProductOption };
export { BILLING_ALERT_TYPE, discoverProducts, matchProduct };
