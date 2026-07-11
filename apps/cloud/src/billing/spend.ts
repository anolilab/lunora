/**
 * Aggregate spend caps (GAPS.md C1). Per-invocation runtime limits cap a single
 * request; this caps an org's *aggregate* period spend so a compromised or
 * abusive account can't rack up unbounded usage. Pure: the evaluator takes the
 * period usage and returns a decision; the enforcement cron does the I/O.
 *
 * Spend is estimated from metered platform usage at the WfP cost basis (the
 * same numbers the pricing maps onto): $0.30/M requests + $0.02/M CPU-ms.
 */

/** Cents per million units — the WfP cost basis. */
const REQUEST_CENTS_PER_MILLION = 30; // $0.30 per 1M requests
const CPU_MS_CENTS_PER_MILLION = 2; // $0.02 per 1M CPU-ms

/** Default aggregate monthly caps (minor units, i.e. cents) per plan. `null` = uncapped. */
export const DEFAULT_SPEND_CAP_MINOR: Record<string, null | number> = {
    enterprise: null,
    free: 500, // $5 — hobby blast-radius, ~x100 the free tier's expected usage
    pro: 20_000, // $200 — a runaway pro app stops before a four-digit bill
};

export interface PeriodUsage {
    cpuMs: number;
    requests: number;
}

/** Estimated period cost in minor units (cents) at the WfP cost basis. */
export const estimatedSpendMinor = (usage: PeriodUsage): number =>
    Math.round((usage.requests * REQUEST_CENTS_PER_MILLION + usage.cpuMs * CPU_MS_CENTS_PER_MILLION) / 1_000_000);

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
