/**
 * The duplicate-subscription policy, opt-in through `singleSubscriptionPerReference`. Every write that can start
 * granting access goes through {@link storeSubscription}, so the policy holds on each path that writes a row.
 */
import type { PaymentStore, RevisionGuard } from "./store";
import type { ProviderId, Subscription, SubscriptionState } from "./types";

/** The states that grant access. */
const ENTITLING_STATES: ReadonlySet<SubscriptionState> = new Set<SubscriptionState>(["active", "trialing"]);

/** Whether `referenceId` holds a live (not canceled) subscription other than `provider`/`subscriptionId`. */
const hasOtherLiveSubscription = async (store: PaymentStore, referenceId: string, provider: ProviderId, subscriptionId: string): Promise<boolean> => {
    const subscriptions = await store.listSubscriptionsByReference(referenceId);

    return subscriptions.some(
        (subscription) => (subscription.provider !== provider || subscription.id !== subscriptionId) && subscription.state !== "canceled",
    );
};

/** `refused`: the policy blocked a write that would grant access. `rejected`: the store's revision guard declined it. */
type SubscriptionWrite = "refused" | "rejected" | "written";

/**
 * Write `next` unless the policy refuses it. A write grants access when `next` entitles and either there was no row,
 * the row did not entitle, or its owner changes. Only such a write is refused, so a duplicate row that already exists
 * does not block updates to the row it already has.
 */
const storeSubscription = async (
    store: PaymentStore,
    singleSubscriptionPerReference: boolean,
    previous: Subscription | undefined,
    next: Subscription,
    guard?: RevisionGuard,
): Promise<SubscriptionWrite> => {
    const grantsAccess =
        ENTITLING_STATES.has(next.state) && (previous === undefined || !ENTITLING_STATES.has(previous.state) || previous.referenceId !== next.referenceId);

    if (
        singleSubscriptionPerReference &&
        grantsAccess &&
        next.referenceId !== "" &&
        (await hasOtherLiveSubscription(store, next.referenceId, next.provider, next.id))
    ) {
        return "refused";
    }

    return (await store.upsertSubscription(next, guard)) ? "written" : "rejected";
};

export { ENTITLING_STATES, storeSubscription };
export type { SubscriptionWrite };
