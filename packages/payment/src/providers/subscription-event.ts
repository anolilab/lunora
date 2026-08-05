/**
 * Map a normalized subscription state to the webhook action it implies.
 *
 * Each adapter first translates its raw provider status into a {@link SubscriptionState} via its own
 * `SUBSCRIPTION_STATE_BY_*_STATUS` table (the only provider-specific part), then routes through this
 * single provider-agnostic function. Keeping the state → action mapping in one place stops it from
 * drifting per adapter (an earlier per-adapter copy had already dropped the `paused` branch).
 */
import type { SubscriptionState, WebhookActionType } from "../types";

const EVENT_TYPE_BY_STATE: Record<SubscriptionState, WebhookActionType> = {
    active: "subscription.active",
    canceled: "subscription.canceled",
    past_due: "subscription.past_due",
    paused: "subscription.paused",
    trialing: "subscription.active",
};

const stateToEventType = (state: SubscriptionState | undefined): WebhookActionType => {
    if (state === undefined) {
        return "subscription.updated";
    }

    // A state outside the union (a drifted/third-party adapter value the map
    // does not know yet) must degrade to the generic `subscription.updated`,
    // never to `undefined` — an `undefined` action breaks webhook sync routing.
    return (EVENT_TYPE_BY_STATE as Record<string, WebhookActionType | undefined>)[state] ?? "subscription.updated";
};

export default stateToEventType;
