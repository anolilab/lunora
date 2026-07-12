/**
 * Overage billing on Creem prepaid credits (GAPS.md C3 follow-up). Creem has
 * no metered subscription pricing (products are `recurring`/`onetime` only),
 * but it ships a first-party credits ledger (per-customer accounts, idempotent
 * credit/debit by `reference`). So overage is **prepaid**: orgs buy credit
 * packs (one-time Creem products; the purchase webhook credits the account),
 * and the platform debits credits for usage beyond the plan's included quota.
 *
 * Prepaid is a feature, not a workaround: there is no surprise invoice — an
 * exhausted balance degrades service (the existing suspension machinery)
 * instead of growing a bill, which is the C1 bill-shock posture, and a credit
 * pack purchase is a normal taxed MoR sale so the tax story stays Creem's.
 *
 * Credits are denominated in **minor units (cents)**: 1 credit = $0.01 of
 * usage at the overage rate. This module is the pure planner; the Creem
 * debit call is the injected 🌐 port.
 */

import type { PeriodUsage } from "./spend";

/** Usage included in each plan per period before overage debits start. */
export const INCLUDED_USAGE: Record<string, PeriodUsage> = {
    enterprise: { cpuMs: 3_000_000_000, requests: 1_000_000_000 },
    free: { cpuMs: 3_000_000, requests: 1_000_000 },
    pro: { cpuMs: 30_000_000, requests: 10_000_000 },
};

/** Overage rates in credits (cents) per million units — cost-plus over the WfP basis. */
const REQUEST_CREDITS_PER_MILLION = 100; // $1.00 per 1M requests (~3.3x cost)
const CPU_MS_CREDITS_PER_MILLION = 10; // $0.10 per 1M CPU-ms (~5x cost)

/** Included usage for a plan; unknown plans get the free allowance (never unlimited). */
export const includedUsageFor = (plan: string): PeriodUsage => INCLUDED_USAGE[plan] ?? INCLUDED_USAGE["free"] ?? { cpuMs: 0, requests: 0 };

/**
 * Cumulative overage credits owed for the period so far: usage beyond the
 * plan's included quota, priced at the overage rates, floored at whole
 * credits. Monotonically non-decreasing within a period, which makes the
 * delta-debit below safe to re-run.
 */
export const overageCreditsOwed = (plan: string, usage: PeriodUsage): number => {
    const included = includedUsageFor(plan);
    const overRequests = Math.max(0, usage.requests - included.requests);
    const overCpuMs = Math.max(0, usage.cpuMs - included.cpuMs);

    return Math.floor((overRequests * REQUEST_CREDITS_PER_MILLION + overCpuMs * CPU_MS_CREDITS_PER_MILLION) / 1_000_000);
};

export interface OverageDebitPlan {
    /** Credits to debit now (owed minus already debited; never negative). */
    debitCredits: number;
    /** Cumulative credits owed for the period after this debit. */
    owedCredits: number;

    /**
     * Idempotent Creem `reference` for this debit: encodes org, period, and
     * the cumulative watermark, so a crashed-and-retried run re-sends the SAME
     * reference for the same delta and Creem dedupes it.
     */
    reference: string;
}

/**
 * Plan the next debit for an org: the delta between cumulative credits owed
 * and what previous runs already debited. Returns null when nothing is owed.
 */
export const planOverageDebit = (input: {
    alreadyDebitedCredits: number;
    organizationId: string;
    periodStart: number;
    plan: string;
    usage: PeriodUsage;
}): null | OverageDebitPlan => {
    const owedCredits = overageCreditsOwed(input.plan, input.usage);
    const debitCredits = owedCredits - input.alreadyDebitedCredits;

    if (debitCredits <= 0) {
        return null;
    }

    return {
        debitCredits,
        owedCredits,
        reference: `overage:${input.organizationId}:${String(input.periodStart)}:${String(owedCredits)}`,
    };
};

/** The Creem credits ledger surface the reconciliation cron needs (🌐 port). */
export interface CreditsLedgerPort {
    /** Current balance in credits, or null when the org has no credits account. */
    balance: (organizationId: string) => Promise<null | number>;
    /** Idempotent debit (Creem dedupes by `reference`). */
    debit: (organizationId: string, credits: number, reference: string) => Promise<void>;
}

export type OverageOutcome = { credits: number; status: "debited" } | { status: "exhausted" } | { status: "none" };

/**
 * Reconcile one org's overage against its prepaid balance. Debits the owed
 * delta when the balance covers it; reports `exhausted` when it doesn't (the
 * caller suspends via the existing C1 machinery — no negative balances, no
 * surprise bills). A missing credits account with owed overage is `exhausted`.
 */
export const reconcileOverage = async (
    input: { alreadyDebitedCredits: number; organizationId: string; periodStart: number; plan: string; usage: PeriodUsage },
    ledger: CreditsLedgerPort,
): Promise<OverageOutcome> => {
    const plan = planOverageDebit(input);

    if (!plan) {
        return { status: "none" };
    }

    const balance = await ledger.balance(input.organizationId);

    if (balance === null || balance < plan.debitCredits) {
        return { status: "exhausted" };
    }

    await ledger.debit(input.organizationId, plan.debitCredits, plan.reference);

    return { credits: plan.debitCredits, status: "debited" };
};

export interface OverageOrgInput {
    alreadyDebitedCredits: number;
    organizationId: string;
    periodStart: number;
    plan: string;
    usage: PeriodUsage;
}

export interface OverageFleetPorts {
    /** Advance the platform-side watermark after a successful debit (forward-only upstream). */
    advanceWatermark: (organizationId: string, periodStart: number, debitedCredits: number) => Promise<void>;
    ledger: CreditsLedgerPort;
    /** Balance can't cover the owed delta — suspend via the C1 machinery. */
    onExhausted: (organizationId: string) => Promise<void>;
}

export interface OverageFleetSummary {
    debitedCredits: number;
    debitedOrgs: number;
    exhausted: number;
}

/**
 * Reconcile every org's overage for the period. Per-org failures are isolated
 * (one org's Creem error never blocks the fleet), the watermark only advances
 * after the debit succeeded, and exhausted orgs go to the suspension hook.
 */
export const reconcileAllOverages = async (organizations: ReadonlyArray<OverageOrgInput>, ports: OverageFleetPorts): Promise<OverageFleetSummary> => {
    const summary: OverageFleetSummary = { debitedCredits: 0, debitedOrgs: 0, exhausted: 0 };

    for (const organization of organizations) {
        try {
            // eslint-disable-next-line no-await-in-loop -- sequential: each org's debit is one paced provider call
            const outcome = await reconcileOverage(organization, ports.ledger);

            if (outcome.status === "debited") {
                // eslint-disable-next-line no-await-in-loop -- watermark write must follow its own debit
                await ports.advanceWatermark(organization.organizationId, organization.periodStart, organization.alreadyDebitedCredits + outcome.credits);
                summary.debitedCredits += outcome.credits;
                summary.debitedOrgs += 1;
            } else if (outcome.status === "exhausted") {
                // eslint-disable-next-line no-await-in-loop -- suspension follows its own org's outcome
                await ports.onExhausted(organization.organizationId);
                summary.exhausted += 1;
            }
        } catch {
            // Isolated: a provider blip on one org is retried on the next run
            // (the watermark did not advance, so nothing is lost or doubled).
        }
    }

    return summary;
};
