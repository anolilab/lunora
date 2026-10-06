/**
 * Entitlements (the native `check` tier).
 *
 * Derives plan / features / limits from already-synced subscription state — cheap and in-Worker,
 * per the design decision to not drag a Postgres billing service into the runtime. Usage metering
 * and credits (`track`) are deferred behind the optional Autumn adapter seam; this is the
 * read-side `check`.
 */
import type { PaymentStore } from "./store";
import type { Subscription } from "./types";

// Only subscriptions in these states confer entitlements.
const ACTIVE_STATES: ReadonlySet<Subscription["state"]> = new Set<Subscription["state"]>(["active", "trialing"]);

/**
 * Every price/product id a subscription bills. `priceIds` when the adapter carried the whole set
 * (a multi-item Stripe subscription: base plan + add-on + metered price), else the single
 * `priceId` — which is what every other provider has and what a row written before `priceIds`
 * existed carries. Testing only `priceId` denied the add-on to the customer paying for it.
 */
const priceIdsOf = (subscription: Subscription): ReadonlyArray<string> => subscription.priceIds ?? [subscription.priceId];

const isActive = (subscription: Subscription): boolean => ACTIVE_STATES.has(subscription.state);

/** Latest `currentPeriodStart` among active subscriptions, optionally only those billing one of `priceIds`. */
const latestPeriodStart = (subscriptions: ReadonlyArray<Subscription>, priceIds?: ReadonlySet<string>): number => {
    let start = 0;

    for (const subscription of subscriptions) {
        if (
            isActive(subscription) &&
            subscription.currentPeriodStart !== undefined &&
            (priceIds === undefined || priceIdsOf(subscription).some((id) => priceIds.has(id)))
        ) {
            start = Math.max(start, subscription.currentPeriodStart);
        }
    }

    return start;
};

/**
 * `PlanDefinition` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export interface PlanDefinition {
    /** Feature flags this plan grants. */
    readonly features?: ReadonlyArray<string>;
    /** Numeric limits this plan grants (e.g. `{ seats: 5 }`). */
    readonly limits?: Record<string, number>;
    /** Provider price/product ids that grant this plan. */
    readonly priceIds: ReadonlyArray<string>;
}

/**
 * `EntitlementsConfig` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export interface EntitlementsConfig {
    /** Plan name → definition. */
    readonly plans: Record<string, PlanDefinition>;
}

/**
 * `Entitlements` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export interface Entitlements {
    readonly features: ReadonlySet<string>;
    /** True when an active subscription grants `feature`. */
    readonly has: (feature: string) => boolean;
    /** The most-generous granted value for a numeric limit, or `undefined`. */
    readonly limit: (key: string) => number | undefined;

    /**
     * Start of the window `featureId`'s metered usage is summed over: the latest period start among
     * the active subscriptions billing the plan its {@link Entitlements.limit} comes from (any other
     * subscription renewing must not reset it). Unlimited by any plan, the latest across every active
     * subscription. `0` (all-time) when none reports a period.
     */
    readonly periodStart: (featureId: string) => number;
    /** Active plan names (a reference can hold more than one). */
    readonly plans: ReadonlyArray<string>;
}

/**
 * Every feature name a config can grant — the union of `features` flags and `limits` keys across all plans, sorted.
 * @experimental
 */
export const featureNames = (config: EntitlementsConfig): string[] => {
    const names = new Set<string>();

    for (const plan of Object.values(config.plans)) {
        for (const feature of plan.features ?? []) {
            names.add(feature);
        }

        for (const key of Object.keys(plan.limits ?? {})) {
            names.add(key);
        }
    }

    return [...names].toSorted((a, b) => a.localeCompare(b));
};

/**
 * Whether the reference holds an entitling (active/trialing) subscription on `priceId` — the basis of a product `check`.
 * @experimental
 */
export const hasActivePrice = (subscriptions: ReadonlyArray<Subscription>, priceId: string): boolean =>
    subscriptions.some((subscription) => isActive(subscription) && priceIdsOf(subscription).includes(priceId));

/**
 * Derive {@link Entitlements} from a reference's subscriptions. Pure — the basis of `check`.
 * @experimental
 */
export const resolveEntitlements = (config: EntitlementsConfig, subscriptions: ReadonlyArray<Subscription>): Entitlements => {
    const activePriceIds = new Set(subscriptions.filter((subscription) => isActive(subscription)).flatMap((subscription) => priceIdsOf(subscription)));

    const plans: string[] = [];
    const features = new Set<string>();
    // Each limit's winning value and the price ids of the plan(s) granting it.
    const limits = new Map<string, { priceIds: Set<string>; value: number }>();

    for (const [name, plan] of Object.entries(config.plans)) {
        if (!plan.priceIds.some((id) => activePriceIds.has(id))) {
            continue;
        }

        plans.push(name);

        for (const feature of plan.features ?? []) {
            features.add(feature);
        }

        for (const [key, value] of Object.entries(plan.limits ?? {})) {
            const current = limits.get(key);

            // Most-generous wins when several active plans cap the same limit; a tie pools both plans.
            if (current === undefined || value > current.value) {
                limits.set(key, { priceIds: new Set(plan.priceIds), value });
            } else if (value === current.value) {
                for (const id of plan.priceIds) {
                    current.priceIds.add(id);
                }
            }
        }
    }

    return {
        features,
        has: (feature) => features.has(feature),
        limit: (key) => limits.get(key)?.value,
        periodStart: (featureId) => latestPeriodStart(subscriptions, limits.get(featureId)?.priceIds),
        plans,
    };
};

/**
 * Latest billing-period start across every active subscription — the usage window when no
 * entitlements are configured. With a config, use {@link Entitlements.periodStart}.
 * @experimental
 */
export const usagePeriodStart = (subscriptions: ReadonlyArray<Subscription>): number => latestPeriodStart(subscriptions);

/**
 * Convenience: resolve entitlements straight from the store for a reference.
 * @experimental
 */
export const entitlementsForReference = async (store: PaymentStore, config: EntitlementsConfig, referenceId: string): Promise<Entitlements> =>
    resolveEntitlements(config, await store.listSubscriptionsByReference(referenceId));
