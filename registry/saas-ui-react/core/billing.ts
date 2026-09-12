/**
 * Billing's view model: what plan a tenant is on, what that entitles them to,
 * and whether they have outgrown it.
 *
 * The plan catalog lives in code rather than in the provider. The provider owns
 * money — prices, invoices, the subscription's state machine — and the app owns
 * what a plan *means*, because "10 seats" is a product decision that has to be
 * enforced in a mutation the provider never sees. Keeping the two apart is also
 * what lets the kit ship six payment adapters behind one UI: nothing here names
 * Stripe.
 */
import type { SubscriptionLike } from "./types";

/** A plan as the app defines it. `priceId` is the provider's; everything else is yours. */
interface Plan {
    /** Marketing copy for the pricing table. One line. */
    blurb: string;
    /** ISO 4217, e.g. `"USD"`. */
    currency: string;
    /** Named capabilities this plan unlocks, checked by {@link isEntitled}. */
    features: ReadonlyArray<string>;
    /** Stable id used in `saas_organizations.plan` and in gating. */
    id: string;
    name: string;
    /** Provider price id for checkout. Absent on a free plan — there is nothing to buy. */
    priceId?: string;
    /** Minor units (cents). `0` renders as "Free". */
    priceMinor: number;
    /** Maximum billable members. `undefined` means unmetered. */
    seats?: number;
}

/**
 * States that entitle a tenant to their plan. `past_due` is deliberately IN:
 * cutting off a customer the moment a card retry fails is how a dunning
 * window becomes a churn event. `paused` and `canceled` are out.
 *
 * `trialing` is in for the obvious reason, and that is the whole point of a
 * trial — a trial that does not entitle is a demo.
 */
const ENTITLING_STATES = new Set(["active", "past_due", "trialing"]);

/** Whether a subscription currently entitles its tenant to anything at all. */
const isEntitling = (subscription: SubscriptionLike | undefined): boolean => subscription !== undefined && ENTITLING_STATES.has(subscription.state);

/**
 * The plan a tenant is actually on. Falls back to the catalog's free plan (the
 * first with no `priceId`) rather than to `undefined`, so a screen never has to
 * branch on "no subscription" separately from "on the free tier" — they are the
 * same state to a user.
 */
const currentPlan = (plans: ReadonlyArray<Plan>, subscription: SubscriptionLike | undefined): Plan | undefined => {
    if (isEntitling(subscription)) {
        const matched = plans.find((plan) => plan.priceId !== undefined && plan.priceId === subscription?.priceId);

        if (matched) {
            return matched;
        }
    }

    return plans.find((plan) => plan.priceId === undefined);
};

/**
 * Whether a tenant may use a named capability.
 *
 * This is the CLIENT-side half, and it decides what to render — never what to
 * allow. The mutation checks the same thing server-side, because a gate a user
 * can edit in devtools is a suggestion. Rendering the upsell instead of the
 * feature is exactly the right use of it.
 */
const isEntitled = (plans: ReadonlyArray<Plan>, subscription: SubscriptionLike | undefined, feature: string): boolean =>
    currentPlan(plans, subscription)?.features.includes(feature) ?? false;

interface SeatUsage {
    /** `undefined` on an unmetered plan. */
    limit?: number;
    /** `true` once `used` exceeds `limit`. Unmetered plans are never over. */
    over: boolean;
    /** Fraction of the allowance consumed, 0-1. `0` when unmetered — there is no bar to draw. */
    ratio: number;
    used: number;
}

/**
 * Seat usage against the plan's allowance.
 *
 * Seats are counted from the organisation's member list, not from
 * `subscription.quantity`: the provider's count is what the tenant is *billed*
 * for, which lags what they are *using* by however long it takes a webhook to
 * land. Showing the billed number would tell someone who just invited three
 * people that nothing happened.
 */
const seatUsage = (plan: Plan | undefined, memberCount: number): SeatUsage => {
    const limit = plan?.seats;

    if (limit === undefined) {
        return { over: false, ratio: 0, used: memberCount };
    }

    return { limit, over: memberCount > limit, ratio: limit === 0 ? 1 : Math.min(1, memberCount / limit), used: memberCount };
};

/**
 * Format a price for display. Falls back to a plain decimal when the runtime
 * has no ICU data (workerd builds without it), because a price rendered as
 * `12.00 USD` is worse than a crash only in the sense that nothing is.
 */
const formatMoney = (amountMinor: number, currency: string, locale?: string): string => {
    const major = amountMinor / 100;

    try {
        return new Intl.NumberFormat(locale, { currency, style: "currency" }).format(major);
    } catch {
        return `${major.toFixed(2)} ${currency}`;
    }
};

/** The pricing table's rows: the catalog, marked with which one is current. */
const pricingRows = (
    plans: ReadonlyArray<Plan>,
    subscription: SubscriptionLike | undefined,
): ReadonlyArray<{ current: boolean; plan: Plan; price: string; priceId?: string; purchasable: boolean }> => {
    const current = currentPlan(plans, subscription);

    return plans.map((plan) => {
        return {
            current: plan.id === current?.id,
            plan,
            price: plan.priceMinor === 0 ? "Free" : formatMoney(plan.priceMinor, plan.currency),
            // Carried rather than re-read from `plan` in the view: reaching back
            // for it needs a non-null assertion to satisfy `purchasable`, and an
            // assertion is how the two drift apart later.
            priceId: plan.priceId,
            // A plan is purchasable when it has a provider price and is not the one
            // you are already on. Downgrades go through the portal, which is the
            // provider's job — proration is not a thing an app should reimplement.
            purchasable: plan.priceId !== undefined && plan.id !== current?.id,
        };
    });
};

/**
 * A one-line status for the billing panel. Separate from the plan name because
 * these two say different things: the plan is what you bought, this is whether
 * it is working.
 */
const subscriptionNotice = (subscription: SubscriptionLike | undefined): string | undefined => {
    if (!subscription) {
        return undefined;
    }

    if (subscription.cancelAtPeriodEnd) {
        return "Cancels at the end of the current period.";
    }

    switch (subscription.state) {
        case "past_due": {
            return "Payment failed — update your card to avoid interruption.";
        }
        case "paused": {
            return "This subscription is paused.";
        }
        case "trialing": {
            return "Trial in progress.";
        }
        default: {
            return undefined;
        }
    }
};

export type { Plan, SeatUsage };
export { currentPlan, ENTITLING_STATES, formatMoney, isEntitled, isEntitling, pricingRows, seatUsage, subscriptionNotice };
