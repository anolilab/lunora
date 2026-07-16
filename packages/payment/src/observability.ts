/**
 * Observability hook.
 *
 * A single discriminated-union callback the engine fires at the points worth alerting on —
 * failed payments, past-due subscriptions, reconciliation drift — plus general webhook telemetry.
 * Telemetry must never break a payment, so {@link notifyObserver} swallows anything the observer
 * throws.
 */
import type { ApplyResult, ProviderId, WebhookActionType } from "./types";

/**
 * `PaymentEvent` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export type PaymentEvent =
    | { action: WebhookActionType; eventId: string; provider: ProviderId; reason: ApplyResult["reason"]; type: "webhook.applied" }
    | { eventId: string; provider: ProviderId; type: "webhook.duplicate" }
    | { error: unknown; id: string; kind: "payment" | "subscription"; provider: ProviderId; type: "reconcile.error" }
    | { id: string; kind: "payment" | "subscription"; provider: ProviderId; type: "reconcile.drift" }
    | { provider: ProviderId; referenceId?: string; sessionId?: string; type: "payment.failed" }
    | { provider: ProviderId; referenceId?: string; subscriptionId?: string; type: "subscription.past_due" }
    | {
          failedPayments: number;
          failedSubscriptions: number;
          provider: ProviderId;
          type: "reconcile.completed";
          updatedPayments: number;
          updatedSubscriptions: number;
      }
    | { featureId: string; provider: ProviderId; referenceId: string; type: "usage.report_failed" };

/**
 * `PaymentObserver` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export type PaymentObserver = (event: PaymentEvent) => void;

/** Invoke an observer without ever letting telemetry break the payment flow. */
export const notifyObserver = (observer: PaymentObserver | undefined, event: PaymentEvent): void => {
    if (!observer) {
        return;
    }

    try {
        observer(event);
    } catch {
        // Observability must never throw — a broken metrics sink can't fail a payment.
    }
};
