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
    /** Active plan names (a reference can hold more than one). */
    readonly plans: ReadonlyArray<string>;
}

/**
 * Start of the window `check` sums metered usage over: the most recent billing-period start among
 * a reference's active subscriptions. `0` (count all-time) when no active subscription reports one
 * — limits still bind, they just never reset until the provider sends a period.
 * @experimental
 */
export const usagePeriodStart = (subscriptions: ReadonlyArray<Subscription>): number => {
    let start = 0;

    for (const subscription of subscriptions) {
        if (ACTIVE_STATES.has(subscription.state) && subscription.currentPeriodStart !== undefined) {
            start = Math.max(start, subscription.currentPeriodStart);
        }
    }

    return start;
};

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
    subscriptions.some((subscription) => subscription.priceId === priceId && ACTIVE_STATES.has(subscription.state));

/**
 * Derive {@link Entitlements} from a reference's subscriptions. Pure — the basis of `check`.
 * @experimental
 */
export const resolveEntitlements = (config: EntitlementsConfig, subscriptions: ReadonlyArray<Subscription>): Entitlements => {
    const activePriceIds = new Set(subscriptions.filter((subscription) => ACTIVE_STATES.has(subscription.state)).map((subscription) => subscription.priceId));

    const plans: string[] = [];
    const features = new Set<string>();
    const limits = new Map<string, number>();

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

            // Most-generous wins when several active plans cap the same limit.
            limits.set(key, current === undefined ? value : Math.max(current, value));
        }
    }

    return {
        features,
        has: (feature) => features.has(feature),
        limit: (key) => limits.get(key),
        plans,
    };
};

/**
 * Convenience: resolve entitlements straight from the store for a reference.
 * @experimental
 */
export const entitlementsForReference = async (store: PaymentStore, config: EntitlementsConfig, referenceId: string): Promise<Entitlements> =>
    resolveEntitlements(config, await store.listSubscriptionsByReference(referenceId));
