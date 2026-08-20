/**
 * Aggregate spend caps (GAPS.md C1) over the **full Cloudflare bill**.
 * Per-invocation runtime limits cap a single request; this caps an org's
 * **aggregate** period spend so a compromised or abusive account can't rack up
 * unbounded usage. Pure: the evaluator takes the period usage and returns a
 * decision; the enforcement cron does the I/O.
 *
 * **The rate card is the whole bill, not just compute.** Pricing only requests
 * + CPU-ms left every storage-shaped runaway invisible to the cap: a tenant can
 * burn far more on Durable Object duration, D1 row reads, or R2 Class A
 * operations than it ever will on Workers-for-Platforms requests, and the cap
 * would never notice. {@link RATE_CARD} carries every dimension Lunora Cloud's
 * products actually consume, with the rate taken from Cloudflare's published
 * pricing pages.
 *
 * **Rates are marginal, and included allowances are deliberately NOT
 * subtracted.** Cloudflare's free tiers (20M Workers-for-Platforms requests,
 * 25 billion Durable Object rows read, …) are granted once to *the platform's*
 * account — not once per tenant. Subtracting a full account allowance per org
 * would let a hundred free orgs each "spend" the platform's entire included
 * tier and stay under their cap. So every unit is priced at the marginal
 * overage rate. That over-estimates a small tenant's true incremental cost,
 * which is the correct direction for a blast-radius control: the cap fires
 * early, never late.
 *
 * **This is an estimate, not an invoice.** The authoritative number for an org
 * that has connected its own Cloudflare account is the Billable Usage API
 * (`lunora/cloudflare-billing.ts`); this model is what the platform can compute
 * for *every* org, including those that have connected nothing.
 *
 * Rates are held as integer **nano-cents per unit** (1 cent = 1e9 nano-cents)
 * so the cheapest published rate — $0.001 per million rows read, i.e. 100
 * nano-cents per row — is still an exact integer. Accumulating in nano-cents
 * and rounding once at the end is what stops a meter whose per-unit price is a
 * fraction of a cent from rounding to zero on every roll-up.
 */

/** Nano-cents in one minor unit (cent). */
const NANO_CENTS_PER_CENT = 1_000_000_000;

/**
 * Every billable dimension the platform meters. One meter per Cloudflare
 * billing dimension, named for the product it belongs to — a meter that maps to
 * two products would make the breakdown lie about where the money went.
 */
export type UsageMeter =
    // Workers for Platforms — the dispatch chain (dispatch → user → outbound
    // Worker) is billed as ONE request, with CPU summed across all three.
    // Workflows invocations bill at the same request/CPU rates and fold in here.
    | "aeDataPoints"
    | "aeReadQueries"
    | "browserHours"
    | "containerCpuSeconds"
    | "containerDiskGbSeconds"
    | "containerMemoryGibSeconds"
    | "cpuMs"
    // D1 — `.global()` tables.
    | "d1RowsRead"
    | "d1RowsWritten"
    | "d1StorageGbMonths"
    // Durable Objects — ShardDO / SessionDO / SchedulerDO.
    | "doDurationGbS"
    | "doRequests"
    | "doRowsRead"
    | "doRowsWritten"
    | "doStorageGbMonths"
    | "imagesDelivered"
    | "imagesStored"
    | "imagesTransformations"
    // Workers KV.
    | "kvDeletes"
    | "kvLists"
    | "kvReads"
    | "kvStorageGbMonths"
    | "kvWrites"
    // Logs — Workers Logs events and Logpush delivery.
    | "logEvents"
    | "logpushRequests"
    | "queueOperations"
    // R2 — `@lunora/storage`. Egress is free and therefore has no meter.
    | "r2ClassAOps"
    | "r2ClassBOps"
    | "r2StorageGbMonths"
    | "requests"
    | "vectorizeQueriedDimensions"
    | "vectorizeStoredDimensions"
    // Vectorize + Workers AI — `@lunora/ai`.
    | "workersAiNeurons"
    // Workflows — steps and state storage are metered on top of request/CPU.
    | "workflowSteps"
    | "workflowStorageGbMonths";

/** Period usage keyed by meter. An absent meter reads as zero. */
export type PeriodUsage = Partial<Record<UsageMeter, number>>;

export interface MeterRate {
    /** Marginal cost of one unit, in nano-cents (1 cent = 1e9). */
    nanoCentsPerUnit: number;
    /** Cloudflare product the meter belongs to — the breakdown groups by this. */
    product: string;
    /** The published rate this was derived from, for auditability. */
    published: string;
    /** What one unit is. */
    unit: string;
}

/**
 * Marginal cost per unit, per Cloudflare's published pricing. `published` keeps
 * the source rate next to the derived integer so a rate change is a one-line
 * diff that can be checked against the pricing page without arithmetic.
 *
 * Not metered here, on purpose: Hyperdrive (unlimited queries on Workers Paid,
 * so no marginal cost), R2 egress (free), and DNS/TLS/bandwidth (included on
 * all plans). A zero-rate meter would imply the platform tracks something it
 * does not.
 */
export const RATE_CARD: Readonly<Record<UsageMeter, MeterRate>> = {
    aeDataPoints: { nanoCentsPerUnit: 25_000, published: "$0.25 / million", product: "Analytics Engine", unit: "data point" },
    aeReadQueries: { nanoCentsPerUnit: 100_000, published: "$1.00 / million", product: "Analytics Engine", unit: "read query" },
    browserHours: { nanoCentsPerUnit: 9_000_000_000, published: "$0.09 / hour", product: "Browser Rendering", unit: "browser hour" },
    containerCpuSeconds: { nanoCentsPerUnit: 2_000_000, published: "$0.000020 / vCPU-second", product: "Containers", unit: "vCPU-second" },
    containerDiskGbSeconds: { nanoCentsPerUnit: 7000, published: "$0.00000007 / GB-second", product: "Containers", unit: "disk GB-second" },
    containerMemoryGibSeconds: { nanoCentsPerUnit: 250_000, published: "$0.0000025 / GiB-second", product: "Containers", unit: "memory GiB-second" },
    cpuMs: { nanoCentsPerUnit: 2000, published: "$0.02 / million", product: "Workers for Platforms", unit: "CPU-millisecond" },
    d1RowsRead: { nanoCentsPerUnit: 100, published: "$0.001 / million", product: "D1", unit: "row read" },
    d1RowsWritten: { nanoCentsPerUnit: 100_000, published: "$1.00 / million", product: "D1", unit: "row written" },
    d1StorageGbMonths: { nanoCentsPerUnit: 75_000_000_000, published: "$0.75 / GB-month", product: "D1", unit: "GB-month" },
    doDurationGbS: { nanoCentsPerUnit: 1_250_000, published: "$12.50 / million GB-s", product: "Durable Objects", unit: "GB-second" },
    doRequests: { nanoCentsPerUnit: 15_000, published: "$0.15 / million", product: "Durable Objects", unit: "request" },
    doRowsRead: { nanoCentsPerUnit: 100, published: "$0.001 / million", product: "Durable Objects", unit: "row read" },
    doRowsWritten: { nanoCentsPerUnit: 100_000, published: "$1.00 / million", product: "Durable Objects", unit: "row written" },
    doStorageGbMonths: { nanoCentsPerUnit: 20_000_000_000, published: "$0.20 / GB-month", product: "Durable Objects", unit: "GB-month" },
    imagesDelivered: { nanoCentsPerUnit: 1_000_000, published: "$1.00 / 100,000", product: "Images", unit: "image delivered" },
    imagesStored: { nanoCentsPerUnit: 5_000_000, published: "$5.00 / 100,000 / month", product: "Images", unit: "image stored" },
    imagesTransformations: { nanoCentsPerUnit: 50_000_000, published: "$0.50 / 1,000", product: "Images", unit: "unique transformation" },
    kvDeletes: { nanoCentsPerUnit: 500_000, published: "$5.00 / million", product: "Workers KV", unit: "key deleted" },
    kvLists: { nanoCentsPerUnit: 500_000, published: "$5.00 / million", product: "Workers KV", unit: "list request" },
    kvReads: { nanoCentsPerUnit: 50_000, published: "$0.50 / million", product: "Workers KV", unit: "key read" },
    kvStorageGbMonths: { nanoCentsPerUnit: 50_000_000_000, published: "$0.50 / GB-month", product: "Workers KV", unit: "GB-month" },
    kvWrites: { nanoCentsPerUnit: 500_000, published: "$5.00 / million", product: "Workers KV", unit: "key written" },
    logEvents: { nanoCentsPerUnit: 60_000, published: "$0.60 / million", product: "Workers Logs", unit: "log event" },
    logpushRequests: { nanoCentsPerUnit: 5000, published: "$0.05 / million", product: "Workers Logpush", unit: "request log" },
    queueOperations: { nanoCentsPerUnit: 40_000, published: "$0.40 / million", product: "Queues", unit: "operation (64 KB)" },
    r2ClassAOps: { nanoCentsPerUnit: 450_000, published: "$4.50 / million", product: "R2", unit: "Class A operation" },
    r2ClassBOps: { nanoCentsPerUnit: 36_000, published: "$0.36 / million", product: "R2", unit: "Class B operation" },
    r2StorageGbMonths: { nanoCentsPerUnit: 1_500_000_000, published: "$0.015 / GB-month", product: "R2", unit: "GB-month" },
    requests: { nanoCentsPerUnit: 30_000, published: "$0.30 / million", product: "Workers for Platforms", unit: "request" },
    vectorizeQueriedDimensions: { nanoCentsPerUnit: 1000, published: "$0.01 / million", product: "Vectorize", unit: "queried dimension" },
    vectorizeStoredDimensions: { nanoCentsPerUnit: 50, published: "$0.05 / 100 million", product: "Vectorize", unit: "stored dimension" },
    workersAiNeurons: { nanoCentsPerUnit: 1_100_000, published: "$0.011 / 1,000 Neurons", product: "Workers AI", unit: "Neuron" },
    workflowSteps: { nanoCentsPerUnit: 800_000, published: "$0.80 / 100,000", product: "Workflows", unit: "step" },
    workflowStorageGbMonths: { nanoCentsPerUnit: 20_000_000_000, published: "$0.20 / GB-month", product: "Workflows", unit: "GB-month" },
};

/** Every meter, in rate-card order — the canonical iteration order. */
export const USAGE_METERS = Object.keys(RATE_CARD) as UsageMeter[];

/** Whether an arbitrary string is a known meter (guards ledger rows from older writers). */
export const isUsageMeter = (value: string): value is UsageMeter => value in RATE_CARD;

/**
 * Estimated period cost in nano-cents. Exact integer arithmetic over the whole
 * rate card; a caller that wants money rounds once, at the end.
 */
export const estimatedSpendNanoCents = (usage: PeriodUsage): number => {
    let total = 0;

    for (const meter of USAGE_METERS) {
        const quantity = usage[meter];

        if (quantity !== undefined && Number.isFinite(quantity) && quantity > 0) {
            total += quantity * RATE_CARD[meter].nanoCentsPerUnit;
        }
    }

    return total;
};

/** Estimated period cost in minor units (cents), rounded once from the nano-cent total. */
export const estimatedSpendMinor = (usage: PeriodUsage): number => Math.round(estimatedSpendNanoCents(usage) / NANO_CENTS_PER_CENT);

export interface SpendLine {
    meter: UsageMeter;
    /** Exact cost of this line in nano-cents — the total is the sum of these, not of the rounded values. */
    nanoCents: number;
    product: string;
    quantity: number;
    unit: string;
}

/**
 * Per-meter cost breakdown, most expensive first, omitting meters with no
 * usage. This is what a "why am I being charged" view (and the agent-facing
 * usage API) needs — a single number tells nobody which product ran away.
 *
 * Lines carry exact nano-cents rather than rounded cents on purpose: rounding
 * each line and summing would disagree with {@link estimatedSpendMinor}, which
 * rounds the total once.
 */
export const spendBreakdown = (usage: PeriodUsage): SpendLine[] => {
    const lines: SpendLine[] = [];

    for (const meter of USAGE_METERS) {
        const quantity = usage[meter];

        if (quantity === undefined || !Number.isFinite(quantity) || quantity <= 0) {
            continue;
        }

        const rate = RATE_CARD[meter];

        lines.push({ meter, nanoCents: quantity * rate.nanoCentsPerUnit, product: rate.product, quantity, unit: rate.unit });
    }

    return lines.toSorted((a, b) => b.nanoCents - a.nanoCents);
};

/** Default aggregate monthly caps (minor units, i.e. cents) per plan. `null` = uncapped. */
export const DEFAULT_SPEND_CAP_MINOR: Record<string, null | number> = {
    enterprise: null,
    free: 500, // $5 — hobby blast-radius, ~x100 the free tier's expected usage
    pro: 20_000, // $200 — a runaway pro app stops before a four-digit bill
};

export interface SpendCapInput {
    /** Org-level override; `undefined` falls back to the plan default. */
    capMinorOverride?: number;
    plan: string;
    usage: PeriodUsage;
}

export interface SpendCapDecision {
    capMinor: null | number;
    spendMinor: number;
    suspend: boolean;
}

/**
 * Whether the org's estimated period spend breaches its cap. An explicit
 * override of `0` disables the cap (support escape hatch); unknown plans get
 * the free-tier default so an unrecognized tier is never uncapped.
 */
export const evaluateSpendCap = (input: SpendCapInput): SpendCapDecision => {
    const planDefault = input.plan in DEFAULT_SPEND_CAP_MINOR ? DEFAULT_SPEND_CAP_MINOR[input.plan] : DEFAULT_SPEND_CAP_MINOR["free"];
    let capMinor: null | number | undefined = planDefault;

    if (input.capMinorOverride !== undefined) {
        capMinor = input.capMinorOverride === 0 ? null : input.capMinorOverride;
    }

    const spendMinor = estimatedSpendMinor(input.usage);

    return { capMinor: capMinor ?? null, spendMinor, suspend: typeof capMinor === "number" && spendMinor >= capMinor };
};
