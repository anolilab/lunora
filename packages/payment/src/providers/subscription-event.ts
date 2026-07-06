/**
 * Map a normalized subscription state to the webhook action it implies.
 *
 * Each adapter first translates its raw provider status into a {@link SubscriptionState} via its own
 * `SUBSCRIPTION_STATE_BY_*_STATUS` table (the only provider-specific part), then routes through this
 * single provider-agnostic function. Keeping the state → action mapping in one place stops it from
 * drifting per adapter (an earlier per-adapter copy had already dropped the `paused` branch).
 */
import type { SubscriptionState, WebhookActionType } from "../types";

const stateToEventType = (state: SubscriptionState | undefined): WebhookActionType => {
    if (state === "canceled") {
        return "subscription.canceled";
    }

    if (state === "past_due") {
        return "subscription.past_due";
    }

    if (state === "paused") {
        return "subscription.paused";
    }

    if (state === "active" || state === "trialing") {
        return "subscription.active";
    }

    return "subscription.updated";
};

export default stateToEventType;
