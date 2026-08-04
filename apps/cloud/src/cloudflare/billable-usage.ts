/**
 * Cloudflare Billable Usage API reader (per-org BYO cost overview). A BYO org
 * connects its *own* Cloudflare account (`lunora/cloudflareBilling.ts`); this
 * module reads that account's authoritative billable usage — one row per product
 * per charge period — so the console can show the org its real Cloudflare spend,
 * as opposed to the control plane's *estimate* (`src/billing/spend.ts`, which
 * multiplies self-reported metering by a fixed WfP cost basis).
 *
 * Two halves, mirroring `src/telemetry/metrics-read.ts`: {@link fetchBillableUsage}
 * does the authenticated `fetch` (the account id + Billing-Read token are
 * action-only), and {@link normalizeBillableUsage} is a pure roll-up the summary
 * action and the tests share.
 *
 * Endpoint: `GET /accounts/{account_id}/billable-usage` — standard Cloudflare
 * envelope, `result` an array of rows, updated daily, gated by a token with the
 * **Billing Read** permission (self-serve accounts only in the API's first
 * release). The per-row field names are mapped **defensively** through the
 * candidate lists in {@link FIELD} below: the endpoint's response schema is not
 * reachable from this build sandbox to pin exactly, so every wire field is read
 * through one centralized map — adjust a candidate list here if the live API
 * names a field differently, and nothing else changes.
 */

const DEFAULT_BASE = "https://api.cloudflare.com/client/v4";

/** A raw billable-usage row (one product × charge period). Shape read defensively via {@link FIELD}. */
export type BillableUsageRow = Record<string, unknown>;

export interface FetchBillableUsageOptions {
    accountId: string;
    apiToken: string;
    /** Override for tests; defaults to the public API base. */
    baseUrl?: string;
    fetch?: typeof globalThis.fetch;
}

interface CloudflareEnvelope {
    errors?: { code?: number; message?: string }[];
    result?: unknown;
    success?: boolean;
}

/**
 * Raised when the Billable-Usage read is rejected as unauthorized (401/403) —
 * the token lacks the Billing Read scope, or the account isn't self-serve. The
 * summary action maps this to a distinct "unauthorized" status so the UI can
 * tell "wrong/insufficient token" apart from a transient failure.
 */
export class BillableUsageAuthError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "BillableUsageAuthError";
    }
}

const stripTrailingSlashes = (value: string): string => {
    let result = value;

    while (result.endsWith("/")) {
        result = result.slice(0, -1);
    }

    return result;
};

/**
 * Read the account's billable usage. Throws {@link BillableUsageAuthError} on
 * 401/403 (bad/insufficient token), and a plain `Error` on any other non-ok
 * response — the caller (`cloudflareBilling.summary`) catches both and fails
 * open to a status view, never surfacing the token or a raw stack to the client.
 */
export const fetchBillableUsage = async (options: FetchBillableUsageOptions): Promise<BillableUsageRow[]> => {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const apiRoot = stripTrailingSlashes(options.baseUrl ?? DEFAULT_BASE);
    const url = `${apiRoot}/accounts/${options.accountId}/billable-usage`;

    const response = await fetchImpl(url, {
        headers: { authorization: `Bearer ${options.apiToken}`, "content-type": "application/json" },
        method: "GET",
    });
    const data: unknown = await response.json().catch(() => null);
    const envelope = (data ?? {}) as CloudflareEnvelope;

    if (response.status === 401 || response.status === 403) {
        const message = envelope.errors?.map((error) => error.message).join("; ") ?? `HTTP ${String(response.status)}`;

        throw new BillableUsageAuthError(message);
    }

    if (!response.ok || envelope.success === false) {
        const message = envelope.errors?.map((error) => error.message).join("; ") ?? `HTTP ${String(response.status)}`;

        throw new Error(`cloudflare billable-usage read failed: ${message}`);
    }

    return Array.isArray(envelope.result) ? (envelope.result as BillableUsageRow[]) : [];
};

/**
 * Candidate wire keys per logical field, read left-to-right (first present
 * wins). Centralizes the defensive mapping so a live-API field rename is a
 * one-line change here, not a hunt through the reader + UI.
 */
const FIELD = {
    cost: ["cost", "amount", "total", "total_cost", "charge"],
    currency: ["currency", "currency_code"],
    periodEnd: ["period_end", "charge_period_end", "end", "billing_period_end"],
    periodStart: ["period_start", "charge_period_start", "start", "billing_period_start"],
    product: ["product", "product_name", "service", "metric", "name"],
    quantity: ["quantity", "usage", "units_used", "amount_used"],
    unit: ["unit", "units", "unit_name"],
} as const;

const pickString = (row: BillableUsageRow, keys: ReadonlyArray<string>): string | null => {
    for (const key of keys) {
        const value = row[key];

        if (typeof value === "string" && value.length > 0) {
            return value;
        }

        if (typeof value === "number" && Number.isFinite(value)) {
            return String(value);
        }
    }

    return null;
};

const pickNumber = (row: BillableUsageRow, keys: ReadonlyArray<string>): number | null => {
    for (const key of keys) {
        const value = row[key];

        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }

        if (typeof value === "string") {
            const parsed = Number.parseFloat(value);

            if (Number.isFinite(parsed)) {
                return parsed;
            }
        }
    }

    return null;
};

/** One product's cost line within a charge period. `costMinor` is cents (rounded from the API's major-unit amount). */
export interface ProductCost {
    costMinor: number;
    currency: string;
    product: string;
    quantity: number | null;
    unit: string | null;
}

/** The normalized cost overview for the account's most recent charge period. */
export interface CloudflareCostView {
    currency: string;
    /** ISO date/label of the period this view covers, or null when the rows carry no period field. */
    periodEnd: string | null;
    periodStart: string | null;
    products: ProductCost[];
    /** Sum of every product line, in minor units (cents). */
    totalMinor: number;
}

const toMinor = (major: number | null): number => (major === null ? 0 : Math.round(major * 100));

/**
 * Roll raw rows up to the account's **most recent charge period**: pick the max
 * `periodEnd` (falling back to `periodStart`), keep only that period's rows,
 * group them by product (summing cost + quantity), and total the lines. Pure —
 * no clock, no I/O — so it's the unit-tested core the summary action reuses.
 * Rows with no period field collapse into a single unlabeled bucket.
 */
export const normalizeBillableUsage = (rows: ReadonlyArray<BillableUsageRow>): CloudflareCostView => {
    const empty: CloudflareCostView = { currency: "USD", periodEnd: null, periodStart: null, products: [], totalMinor: 0 };

    if (rows.length === 0) {
        return empty;
    }

    // The period key each row sorts on — periodEnd, else periodStart, else "".
    const periodKeyOf = (row: BillableUsageRow): string => pickString(row, FIELD.periodEnd) ?? pickString(row, FIELD.periodStart) ?? "";

    let latestKey = "";

    for (const row of rows) {
        const key = periodKeyOf(row);

        if (key > latestKey) {
            latestKey = key;
        }
    }

    const inPeriod = rows.filter((row) => periodKeyOf(row) === latestKey);

    const byProduct = new Map<string, ProductCost>();
    let currency = "USD";
    let periodStart: string | null = null;
    let periodEnd: string | null = null;

    for (const row of inPeriod) {
        const product = pickString(row, FIELD.product) ?? "Unknown";
        const rowCurrency = pickString(row, FIELD.currency);

        if (rowCurrency) {
            currency = rowCurrency;
        }

        periodStart = periodStart ?? pickString(row, FIELD.periodStart);
        periodEnd = periodEnd ?? pickString(row, FIELD.periodEnd);

        const costMinor = toMinor(pickNumber(row, FIELD.cost));
        const quantity = pickNumber(row, FIELD.quantity);
        const unit = pickString(row, FIELD.unit);
        const existing = byProduct.get(product);

        if (existing) {
            existing.costMinor += costMinor;

            if (quantity !== null) {
                existing.quantity = (existing.quantity ?? 0) + quantity;
            }
        } else {
            byProduct.set(product, { costMinor, currency, product, quantity, unit });
        }
    }

    const products = [...byProduct.values()].toSorted((a, b) => b.costMinor - a.costMinor);
    const totalMinor = products.reduce((sum, line) => sum + line.costMinor, 0);

    return { currency, periodEnd, periodStart, products, totalMinor };
};
