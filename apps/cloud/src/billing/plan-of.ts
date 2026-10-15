import type { Subscription } from "@lunora/payment";
import { resolveEntitlements } from "@lunora/payment";

import { highestPlan, LUNORA_CLOUD_PLANS } from "./plans";

/**
 * The plan an organization is on, from its synced subscriptions: the highest
 * plan any active subscription grants, or `free` when none does.
 *
 * This is what spend caps and overage bill against. The `organizations.plan`
 * column is not read for money: the caller chose it when the organization was
 * created, and checkout never rewrites it, so it could bill a paying organization
 * as free or a free one as enterprise.
 */
export const planFromSubscriptions = (subscriptions: ReadonlyArray<Subscription>): string =>
    highestPlan(resolveEntitlements(LUNORA_CLOUD_PLANS, subscriptions).plans);

/**
 * The plan of every organization that has subscriptions, keyed by `referenceId`
 * (the organization id). Organizations with none are absent, so a caller falls
 * back to `free`.
 */
export const plansByReference = (subscriptions: ReadonlyArray<Subscription & { referenceId: string }>): Map<string, string> => {
    const byReference = new Map<string, Subscription[]>();

    for (const subscription of subscriptions) {
        const group = byReference.get(subscription.referenceId) ?? [];

        group.push(subscription);
        byReference.set(subscription.referenceId, group);
    }

    return new Map([...byReference].map(([reference, group]) => [reference, planFromSubscriptions(group)]));
};
