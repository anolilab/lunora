/**
 * The duplicate-subscription policy, opt-in through `singleSubscriptionPerReference`. Every write that can start
 * granting access goes through {@link storeSubscription}, so the policy holds on each path that writes a row.
 */
import type { PaymentStore, RevisionGuard } from "./store";
import type { ProviderId, Subscription, SubscriptionState } from "./types";

/** The states that grant access. */
const ENTITLING_STATES: ReadonlySet<SubscriptionState> = new Set<SubscriptionState>(["active", "trialing"]);

/**
 * Whether `referenceId` holds a subscription that grants access, other than `provider`/`subscriptionId`. Paused and
 * past-due rows grant nothing, so they do not block: each activation is checked when it happens.
 */
const hasOtherLiveSubscription = async (store: PaymentStore, referenceId: string, provider: ProviderId, subscriptionId: string): Promise<boolean> => {
    const subscriptions = await store.listSubscriptionsByReference(referenceId);

    return subscriptions.some(
        (subscription) => (subscription.provider !== provider || subscription.id !== subscriptionId) && ENTITLING_STATES.has(subscription.state),
    );
};

/** `refused`: the policy blocked a write that would grant access. `rejected`: the store's revision guard declined it. */
type SubscriptionWrite = "refused" | "rejected" | "written";

/**
 * Write `next` unless the policy refuses it. A write grants access when `next` entitles and either there was no row,
 * the row did not entitle, or its owner changes. Only such a write is refused, so a duplicate row that already exists
 * does not block updates to the row it already has.
 *
 * A refused subscription is still recorded, in a state that grants nothing, so the customer can cancel it in the app
 * and the provider's later events for it find a row. A row that already granted access is left as it is.
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
        next.referenceId.trim() !== "" &&
        (await hasOtherLiveSubscription(store, next.referenceId, next.provider, next.id))
    ) {
        if (previous !== undefined && ENTITLING_STATES.has(previous.state) && previous.referenceId.trim() !== "") {
            // The row already grants access under a real owner. That owner stays; the rest of the update applies.
            const kept: Subscription = { ...next, referenceId: previous.referenceId };

            return (await store.upsertSubscription(kept, guard)) ? "refused" : "rejected";
        }

        // The provider still bills a refused subscription, but it must grant nothing and must stay cancellable under the
        // owner it asked for. A stored row that grants nothing keeps its state, except a canceled one, which would stop the
        // customer cancelling. Everything else is recorded as paused: past due is a paid tier to consumers that treat it as one.
        const keepsState = previous !== undefined && !ENTITLING_STATES.has(previous.state) && previous.state !== "canceled";
        const recorded: Subscription = { ...next, state: keepsState ? previous.state : "paused" };

        return (await store.upsertSubscription(recorded, guard)) ? "refused" : "rejected";
    }

    return (await store.upsertSubscription(next, guard)) ? "written" : "rejected";
};

export { ENTITLING_STATES, hasOtherLiveSubscription, storeSubscription };
export type { SubscriptionWrite };
