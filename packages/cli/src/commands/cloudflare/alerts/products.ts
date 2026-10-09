/**
 * Which `product` a Usage Based Billing notification (`billing_usage_alert`)
 * takes for each metric.
 *
 * The identifiers are documented: Cloudflare's Terraform provider (v4.52.0,
 * `docs/resources/notification_policy.md`) lists eight, and none of them is for
 * D1 or for Workers CPU time — so those two have no usage alert at all, and the
 * account-wide budget alert is their only guard. The account is still read
 * first: the `filter_options` that `GET /alerting/v3/available_alerts` returns
 * for the alert type (PascalCase in Cloudflare's OpenAPI example —
 * `{ Key, AvailableValues: [{ ID, Description }] }` — so keys are matched
 * case-insensitively), and the `filters.product` of policies already on the
 * account. A value the account offers wins over the documented list.
 * @see https://github.com/cloudflare/terraform-provider-cloudflare/blob/v4.52.0/docs/resources/notification_policy.md
 */
import type { MetricId } from "./usage";

const BILLING_ALERT_TYPE = "billing_usage_alert";

/** The documented `product` value per metric. Absent: Cloudflare offers no usage alert for it. */
const DOCUMENTED_PRODUCTS: Partial<Record<MetricId, string>> = {
    "do-duration": "worker_durable_objects_duration",
    "do-requests": "worker_durable_objects_requests",
    "do-rows-read": "worker_durable_objects_storage_reads",
    "do-rows-written": "worker_durable_objects_storage_writes",
    "workers-requests": "worker_requests",
};

interface ProductOption {
    id: string;
    label?: string;
    source: "available-alerts" | "documented" | "existing-policy";
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

/** `record[name]`, matching the key case-insensitively (`Key`, `key`, `KEY`). */
const field = (record: Record<string, unknown>, name: string): unknown => {
    const wanted = name.toLowerCase();
    const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === wanted);

    return key === undefined ? undefined : record[key];
};

const firstString = (record: Record<string, unknown>, names: ReadonlyArray<string>): string | undefined => {
    for (const name of names) {
        const value = field(record, name);

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
    const id = record === undefined ? undefined : firstString(record, ["id", "value", "key", "name"]);

    if (record === undefined || id === undefined) {
        return undefined;
    }

    const label = firstString(record, ["description", "label", "display_name", "displayName", "name"]);

    return { id, source: "available-alerts", ...(label === undefined || label === id ? {} : { label }) };
};

const VALUE_LIST_KEYS = ["AvailableValues", "available_values", "values", "options", "enum", "choices"] as const;

const toOptions = (list: ReadonlyArray<unknown>): ProductOption[] =>
    list.map((entry) => productFromEntry(entry)).filter((option): option is ProductOption => option !== undefined);

/** The value lists of a `{ Key: "product", AvailableValues: [...] }`-shaped record (any key case), else nothing. */
const listedProducts = (record: Record<string, unknown>): ProductOption[] => {
    if (firstString(record, ["key", "name", "filter", "id"]) !== "product") {
        return [];
    }

    return VALUE_LIST_KEYS.flatMap((key) => {
        const list = field(record, key);

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
        if (key.toLowerCase() === "product" && Array.isArray(value)) {
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
            const match = items.map((item) => asRecord(item)).find((item) => item !== undefined && field(item, "type") === BILLING_ALERT_TYPE);

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

/** Combine both account sources, keeping the richer `available_alerts` entry when an id shows up in both. */
const discoverProducts = (
    availableAlerts: unknown,
    availableAlertsRead: boolean,
    policies: ReadonlyArray<{ alert_type?: string; filters?: { product?: unknown } }>,
): ProductDiscovery => {
    const alertType = findBillingAlertType(availableAlerts);
    const fromOptions: ProductOption[] = [];

    if (alertType !== undefined) {
        collectProducts(field(alertType, "filter_options"), 0, fromOptions);
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
 * What an undocumented product's id or label must say to stand for each metric:
 * a word starting with one of the alternatives in every `all` group, and no
 * word starting with anything in `none`. Only consulted for ids the account
 * offers that are not on the documented list.
 */
const MATCHERS: Record<MetricId, { all: ReadonlyArray<ReadonlyArray<string>>; none?: ReadonlyArray<string> }> = {
    "d1-rows-read": { all: [["d1"], ["read"]] },
    "d1-rows-written": { all: [["d1"], ["writ"]] },
    "do-duration": { all: [["durable"], ["duration"]] },
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

type ProductMatch = { candidates: string[]; status: "ambiguous" } | { product: ProductOption; status: "matched" } | { status: "no-product" };

/**
 * The product for `metric`: the documented id when the account offers it, else
 * the one offered id that names the metric, else the documented id itself.
 * `no-product` means Cloudflare has no usage alert for the metric.
 */
const matchProduct = (metric: MetricId, products: ReadonlyArray<ProductOption>): ProductMatch => {
    const documented = DOCUMENTED_PRODUCTS[metric];
    const offered = documented === undefined ? undefined : products.find((product) => product.id === documented);

    if (offered !== undefined) {
        return { product: offered, status: "matched" };
    }

    const documentedIds = new Set(Object.values(DOCUMENTED_PRODUCTS));
    const matches = products.filter((product) => !documentedIds.has(product.id) && namesMetric(metric, product));

    if (matches.length === 1 && matches[0] !== undefined) {
        return { product: matches[0], status: "matched" };
    }

    if (matches.length > 1) {
        return { candidates: matches.map((product) => product.id), status: "ambiguous" };
    }

    return documented === undefined ? { status: "no-product" } : { product: { id: documented, source: "documented" }, status: "matched" };
};

export type { ProductDiscovery, ProductMatch, ProductOption };
export { BILLING_ALERT_TYPE, discoverProducts, DOCUMENTED_PRODUCTS, matchProduct };
