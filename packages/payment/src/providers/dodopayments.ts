/**
 * Dodo Payments adapter.
 *
 * Dodo Payments (dodopayments.com) is a **Merchant-of-Record** — like Polar, it is the legal seller
 * of record, calculates/collects/remits tax across 190+ jurisdictions, and owns chargebacks and
 * disputes. So there is no manual authorize/capture (those throw); refunds, however, are first-class
 * (`refunds.create`). The flow is checkout-session → subscription/payment, synced from **Standard
 * Webhooks** (Svix: `webhook-id` / `webhook-timestamp` / `webhook-signature`), verified by
 * {@link verifyStandardWebhook} — the same scheme as Polar.
 *
 * Takes an injected, structural `DodoPaymentsClientLike` (so this package never imports the
 * `dodopayments` SDK); pass `new DodoPayments({ bearerToken })` from the app. Dodo amounts are
 * integer minor units (matching `Money` 1:1), and its billing dates are ISO-8601 strings.
 */
import type DodoPayments from "dodopayments";

import type { PaymentAdapter, WebhookInput } from "../adapter";
import { LunoraPaymentError } from "../errors";
import { idempotencyKey } from "../idempotency";
import { asRecord, parseTimestamp, readBoolean, readNumber, readString, referenceFromMetadata } from "../json";
import { money, zeroMoney } from "../money";
import type {
    CaptureInput,
    CheckoutInput,
    CheckoutResult,
    Customer,
    CustomerRef,
    PaymentSession,
    PaymentState,
    PortalInput,
    RefundInput,
    ReportUsageInput,
    Subscription,
    SubscriptionPatch,
    SubscriptionState,
    WebhookAction,
} from "../types";
import { verifyStandardWebhook } from "../webhook";
import makeNotSupported from "./not-supported";
import stateToEventType from "./subscription-event";

/**
 * The `dodopayments` SDK surface the adapter uses, as a structural type — a real `DodoPayments`
 * instance satisfies it without a cast. Resources are `unknown` (the adapter re-types the client as
 * the real `DodoPayments` internally); this keeps the SDK's full type out of the published declarations.
 * @experimental
 */
interface DodoPaymentsClientLike {
    readonly checkoutSessions: unknown;
    readonly customers: unknown;
    readonly payments: unknown;
    readonly refunds: unknown;
    readonly subscriptions: unknown;
    readonly usageEvents: unknown;
}

/**
 * `DodoPaymentsAdapterOptions` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
interface DodoPaymentsAdapterOptions {
    readonly client: DodoPaymentsClientLike;
    readonly webhookSecret: string;
    readonly webhookToleranceSeconds?: number;
}

const PAYMENT_STATE_BY_DODO_STATUS: Record<string, PaymentState> = {
    cancelled: "canceled",
    failed: "failed",
    partially_captured: "captured",
    partially_captured_and_capturable: "captured",
    processing: "initiated",
    requires_capture: "authorized",
    requires_confirmation: "initiated",
    requires_customer_action: "authorized",
    requires_merchant_action: "authorized",
    requires_payment_method: "initiated",
    succeeded: "captured",
};

const SUBSCRIPTION_STATE_BY_DODO_STATUS: Record<string, SubscriptionState> = {
    active: "active",
    cancelled: "canceled",
    expired: "canceled",
    // SECURITY: `pending` (first payment not completed), `failed`, and `on_hold` (dunning) must not
    // map to an entitling state — see the equivalent `incomplete` note in the Stripe/Polar adapters.
    // Treat them as non-entitling `past_due`; Dodo has no trial status in this enum.
    failed: "past_due",
    on_hold: "past_due",
    // A paused subscription is non-entitling until it resumes, but distinct from dunning — it maps to
    // the `paused` state so a `subscription.paused` webhook routes to `subscription.paused` (not the
    // generic `subscription.updated`) and stays consistent with `subscriptionFromDodo`.
    paused: "paused",
    pending: "past_due",
};

const notSupported = makeNotSupported("dodopayments (merchant-of-record)");

/** A whole number of minor units, the only string shape `readMinorUnits` will accept. */
const WHOLE_MINOR_UNITS = /^-?\d+$/;

/**
 * Minor units from a Dodo money field that may arrive as a number **or** a string.
 *
 * `refund.succeeded` carries `Refund.amount` as a `number`, but `dispute.*` carries
 * `GetDispute.amount` as a **string** ("represented as a string to accommodate precision"), which a
 * plain `readNumber` reads as `undefined` — so a lost chargeback reversed `0`.
 *
 * A digits-only string is read as minor units, matching every money field Dodo *does* document
 * (`total_amount`: "the currency's smallest unit — cents for USD, yen for JPY, fils for KWD"). A
 * string that is not a whole number is refused rather than scaled: Dodo does not document the
 * dispute amount's unit, and choosing between `"25.00"` meaning 25 and meaning 2500 is a 100x error
 * on a funds reversal. Returning `undefined` leaves the action with no amount, which `sync.ts`
 * records as a FULL reversal with the money untouched — loud and fail-closed — rather than writing a
 * confidently wrong figure into the ledger.
 */
const readMinorUnits = (object: Record<string, unknown>, key: string): bigint | undefined => {
    const value = object[key];

    if (typeof value === "number") {
        // Round before BigInt, as elsewhere in this adapter: a stray fractional number would throw a
        // RangeError out of the parse path (a webhook 400 → provider retry loop).
        return Number.isFinite(value) ? BigInt(Math.round(value)) : undefined;
    }

    return typeof value === "string" && WHOLE_MINOR_UNITS.test(value) ? BigInt(value) : undefined;
};

const customerIdOf = (object: Record<string, unknown>): string | undefined =>
    readString(asRecord(object.customer), "customer_id") ?? readString(object, "customer_id");

const subscriptionFromDodo = (input: unknown): Subscription => {
    const subscription = asRecord(input);
    const now = Date.now();
    const status = readString(subscription, "status") ?? "";

    return {
        cancelAtPeriodEnd: readBoolean(subscription, "cancel_at_next_billing_date") ?? false,
        createdAt: now,
        currentPeriodEnd: parseTimestamp(readString(subscription, "next_billing_date")),
        currentPeriodStart: parseTimestamp(readString(subscription, "previous_billing_date")),
        id: readString(subscription, "subscription_id") ?? "",
        priceId: readString(subscription, "product_id") ?? "",
        provider: "dodopayments",
        quantity: readNumber(subscription, "quantity") ?? 1,
        referenceId: referenceFromMetadata(subscription) ?? customerIdOf(subscription) ?? "",
        // Fail closed: an unrecognized Dodo status is treated as non-entitling `past_due`.
        state: SUBSCRIPTION_STATE_BY_DODO_STATUS[status] ?? "past_due",
        updatedAt: now,
    };
};

const paymentFromDodo = (input: unknown): PaymentSession => {
    const payment = asRecord(input);
    const now = Date.now();
    const currency = readString(payment, "currency") ?? "usd";
    // Round before BigInt: Dodo documents integer minor units, but a stray fractional amount would
    // throw a RangeError out of the parse path (a webhook 400 → provider retry loop). Match Autumn.
    const amount = money(BigInt(Math.round(readNumber(payment, "total_amount") ?? 0)), currency);
    const state = PAYMENT_STATE_BY_DODO_STATUS[readString(payment, "status") ?? ""] ?? "initiated";

    return {
        amount,
        capturedAmount: state === "captured" ? amount : zeroMoney(currency),
        createdAt: now,
        id: readString(payment, "payment_id") ?? "",
        provider: "dodopayments",
        referenceId: referenceFromMetadata(payment) ?? "",
        refundedAmount: zeroMoney(currency),
        state,
        updatedAt: now,
    };
};

const mapEvent = (eventId: string, eventType: string, object: Record<string, unknown>): WebhookAction => {
    const base = { eventId, provider: "dodopayments" as const, raw: { object, type: eventType } };
    const currency = readString(object, "currency") ?? "usd";

    switch (eventType) {
        // A lost chargeback (`dispute.lost`) is a definitive funds reversal carrying `amount` +
        // `payment_id` — economically a refund, so it shares the refund mapping (record it so a customer
        // who charges back doesn't stay entitled). Provisional dispute stages move no money and stay
        // `unhandled`; a won dispute needs no transition.
        case "dispute.lost":
        case "refund.succeeded": {
            // `refund.succeeded` reports a number, `dispute.lost` a string — see `readMinorUnits`.
            const minorUnits = readMinorUnits(object, "amount");

            return {
                ...base,
                amount: minorUnits === undefined ? undefined : money(minorUnits, currency),
                referenceId: referenceFromMetadata(object),
                // Per-refund identity for the sync layer's marker match. A lost dispute is not a refund
                // the facade issued, so `dispute_id` stands in: distinct from every refund id, it can
                // never consume a marker and have its reversal silently dropped.
                refundId: readString(object, "refund_id") ?? readString(object, "dispute_id"),
                sessionId: readString(object, "payment_id"),
                type: "payment.refunded",
            };
        }
        // A cancelled payment never settled — record it as a non-entitling failure (there is no
        // dedicated `payment.canceled` action; `failed` is the closest non-entitling state).
        case "payment.cancelled":
        case "payment.failed": {
            return { ...base, referenceId: referenceFromMetadata(object), sessionId: readString(object, "payment_id"), type: "payment.failed" };
        }
        case "payment.succeeded": {
            return {
                ...base,
                amount: money(BigInt(Math.round(readNumber(object, "total_amount") ?? 0)), currency),
                customerId: customerIdOf(object),
                referenceId: referenceFromMetadata(object),
                sessionId: readString(object, "payment_id"),
                subscriptionId: readString(object, "subscription_id"),
                type: "payment.captured",
            };
        }

        case "subscription.active":
        case "subscription.cancelled":
        case "subscription.expired":
        case "subscription.failed":
        case "subscription.on_hold":
        case "subscription.paused":
        case "subscription.plan_changed":
        case "subscription.renewed":
        case "subscription.updated": {
            // The event name is authoritative for a pause: Dodo's `SubscriptionStatus` is
            // pending|active|on_hold|cancelled|failed|expired, with no `paused` member, so a
            // `subscription.paused` payload cannot say so itself. Read from the status alone, a
            // deliberate pause landed on the fail-closed `past_due` and raised the dunning alert
            // `sync.ts` emits for it. `paused` is non-entitling either way — this only stops a
            // customer-initiated pause from being reported as a failed payment.
            //
            // The label lasts until the next `reconcile` and no longer: `getSubscriptionStatus` reads
            // the same enum, so it re-reports `past_due` and reconcile — which trusts the adapter for
            // subscriptions — writes that back (as `reconcile.drift`, not a fresh dunning alert). Not
            // preserved the way `mergePaymentTruth` preserves a refund: a refund is monotone and
            // fails safe, whereas pinning `paused` over provider truth would keep a subscription that
            // resumed out-of-band non-entitling forever, defeating the one sweep meant to catch a
            // missed resume. So `paused -> resume` is a webhook-only edge here; on Stripe and Creem,
            // whose status enums do carry `paused`, the label survives reconcile.
            const status = eventType === "subscription.paused" ? "paused" : readString(object, "status");

            return {
                ...base,
                cancelAtPeriodEnd: readBoolean(object, "cancel_at_next_billing_date"),
                currentPeriodEnd: parseTimestamp(readString(object, "next_billing_date")),
                currentPeriodStart: parseTimestamp(readString(object, "previous_billing_date")),
                customerId: customerIdOf(object),
                priceId: readString(object, "product_id"),
                quantity: readNumber(object, "quantity"),
                referenceId: referenceFromMetadata(object) ?? customerIdOf(object),
                subscriptionId: readString(object, "subscription_id"),
                // Fail closed before `stateToEventType` — an unmapped status must not degrade to a
                // state-preserving metadata patch.
                type: stateToEventType(SUBSCRIPTION_STATE_BY_DODO_STATUS[status ?? ""] ?? "past_due"),
            };
        }

        default: {
            // payment.processing, refund.failed, other dispute.*, license_key.* — no state transition here.
            return { ...base, type: "unhandled" };
        }
    }
};

/**
 * `createDodoPaymentsAdapter` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export const createDodoPaymentsAdapter = (options: DodoPaymentsAdapterOptions): PaymentAdapter => {
    const { webhookSecret } = options;
    // Use the injected client as the real `DodoPayments` internally so every call is checked against the SDK.
    const client = options.client as unknown as DodoPayments;

    return {
        // Dodo is a Merchant-of-Record: it moves the money, so there is no manual payment-intent
        // authorize/capture/cancel. Refunds, however, are supported below.
        cancelPayment: () => notSupported("manual payment cancellation"),

        cancelSubscription: async (subscriptionId, cancelOptions) => {
            // Same endpoint either way — only the body differs (schedule vs. immediate). `as const` keeps
            // "cancelled" a literal so it satisfies Dodo's `SubscriptionStatus` enum, not a widened string.
            const body = cancelOptions?.atPeriodEnd ? { cancel_at_next_billing_date: true } : { status: "cancelled" as const };

            return subscriptionFromDodo(await client.subscriptions.update(subscriptionId, body));
        },

        capabilities: { merchantOfRecord: true, portal: true, usageMetering: true },

        capturePayment: (_input: CaptureInput) => notSupported("manual capture"),

        createCheckout: async (input: CheckoutInput): Promise<CheckoutResult> => {
            const session = asRecord(
                await client.checkoutSessions.create({
                    // An existing Dodo customer is attached by id; otherwise Dodo collects one at checkout.
                    customer: input.customerId ? { customer_id: input.customerId } : undefined,
                    // Pin the framework-controlled `referenceId` LAST so caller metadata can never override it.
                    metadata: { ...input.metadata, referenceId: input.referenceId },
                    product_cart: [{ product_id: input.priceId, quantity: input.quantity ?? 1 }],
                    return_url: input.successUrl,
                }),
            );

            return { id: readString(session, "session_id") ?? "", provider: "dodopayments", url: readString(session, "checkout_url") ?? "" };
        },

        createPortalSession: async (input: PortalInput) => {
            const session = asRecord(await client.customers.customerPortal.create(input.customerId, { return_url: input.returnUrl }));

            return { url: readString(session, "link") ?? readString(session, "url") ?? "" };
        },

        getOrCreateCustomer: async (ref: CustomerRef): Promise<Customer> => {
            // Dodo's `customers.create` is NOT idempotent by email, so a retried/raced first checkout
            // for the same reference would mint duplicate customers. The store lookup the facade puts in
            // front of this call is what actually prevents that: the key below is INERT on this SDK,
            // which drops it rather than sending a header (see the `@lunora/payment` idempotency
            // docblock). It is passed anyway so the call is covered the day the SDK starts honouring it.
            const customer = asRecord(
                await client.customers.create(
                    { email: ref.email ?? "", name: ref.metadata?.name ?? ref.referenceId },
                    { idempotencyKey: idempotencyKey("customer", "dodopayments", ref.referenceId) },
                ),
            );

            return {
                createdAt: Date.now(),
                email: readString(customer, "email") ?? ref.email,
                id: readString(customer, "customer_id") ?? "",
                provider: "dodopayments",
                referenceId: ref.referenceId,
            };
        },

        getPaymentStatus: async (sessionId) => paymentFromDodo(await client.payments.retrieve(sessionId)),

        getSubscriptionStatus: async (subscriptionId) => subscriptionFromDodo(await client.subscriptions.retrieve(subscriptionId)),

        identifier: "dodopayments",

        parseWebhook: async ({ headers, payload }: WebhookInput): Promise<WebhookAction> => {
            const webhookId = headers.get("webhook-id") ?? "";

            await verifyStandardWebhook({
                payload,
                secret: webhookSecret,
                toleranceSeconds: options.webhookToleranceSeconds,
                webhookId,
                webhookSignature: headers.get("webhook-signature") ?? "",
                webhookTimestamp: headers.get("webhook-timestamp") ?? "",
            });

            const event = asRecord(JSON.parse(payload));

            // Standard Webhooks carries no body id, so the `webhook-id` header is our idempotency key.
            return mapEvent(webhookId, readString(event, "type") ?? "", asRecord(event.data));
        },

        refundPayment: async (input: RefundInput) => {
            // Dodo's refund API takes no flat amount — a partial refund is expressed per line item
            // (`items[].item_id` + amount), which this amount-based interface can't supply. Fail loudly
            // rather than silently issuing a FULL refund when a partial one was requested.
            if (input.amount !== undefined) {
                throw new LunoraPaymentError(
                    "PROVIDER_ERROR",
                    "dodopayments refunds a payment in full; partial refunds require line items and aren't supported here",
                );
            }

            const refund = asRecord(await client.refunds.create({ payment_id: input.sessionId, reason: input.reason }));
            const currency = readString(refund, "currency") ?? "usd";
            const refundedAmount = money(BigInt(Math.round(readNumber(refund, "amount") ?? 0)), currency);

            // Dodo refunds can settle asynchronously (`pending`/`review` → later `refund.succeeded` or
            // `refund.failed`). Reflect the refund's real status instead of optimistically claiming
            // "refunded"; the webhook-synced store stays authoritative for the final state. `pending`
            // says so explicitly, so the facade does not have to infer it from the SESSION's state —
            // it holds its ledger back until `refund.succeeded` lands, because `refund.failed` carries
            // no transition and would leave an optimistic write over-stating the row for good.
            const settled = readString(refund, "status") === "succeeded";
            const state: PaymentState = settled ? "refunded" : "captured";

            return {
                amount: refundedAmount,
                capturedAmount: refundedAmount,
                createdAt: Date.now(),
                id: input.sessionId,
                pending: !settled,
                provider: "dodopayments",
                referenceId: "",
                refundedAmount,
                // The same id Dodo's confirming `refund.succeeded` carries.
                refundId: readString(refund, "refund_id"),
                state,
                updatedAt: Date.now(),
            };
        },

        reportUsage: async (input: ReportUsageInput) => {
            // Dodo usage-events ingest: one event per usage record, keyed to the Dodo customer id; the
            // idempotency key dedupes, and metadata carries the metered value.
            await client.usageEvents.ingest({
                events: [
                    {
                        customer_id: input.customerId ?? input.referenceId,
                        event_id: input.idempotencyKey,
                        event_name: input.featureId,
                        metadata: { value: input.quantity },
                        timestamp: input.timestamp === undefined ? undefined : new Date(input.timestamp).toISOString(),
                    },
                ],
            });
        },

        resumeSubscription: async (subscriptionId) => {
            const subscription = await client.subscriptions.update(subscriptionId, { cancel_at_next_billing_date: false });

            return subscriptionFromDodo(subscription);
        },

        updateSubscription: async (subscriptionId, patch: SubscriptionPatch) => {
            // A plan and/or quantity change goes through Dodo's dedicated change-plan endpoint (prorated
            // immediately), then we re-read the authoritative subscription. `changePlan` REQUIRES BOTH
            // `product_id` and `quantity`, so a patch that sets only one side (plan-only OR quantity-only)
            // must fill the other from the current subscription — otherwise the missing side would
            // silently reset (a quantity-only patch was previously dropped entirely).
            if (patch.priceId !== undefined || patch.quantity !== undefined) {
                const current = asRecord(
                    patch.priceId !== undefined && patch.quantity !== undefined ? undefined : await client.subscriptions.retrieve(subscriptionId),
                );

                // Un-deduped on purpose, for want of anywhere to put a key: `SubscriptionChangePlanParams`
                // has no idempotency field and this SDK never sends the header one. A retry prorates twice.
                await client.subscriptions.changePlan(subscriptionId, {
                    product_id: patch.priceId ?? readString(current, "product_id") ?? "",
                    proration_billing_mode: "prorated_immediately",
                    quantity: patch.quantity ?? readNumber(current, "quantity") ?? 1,
                });
            }

            return subscriptionFromDodo(await client.subscriptions.retrieve(subscriptionId));
        },
    };
};

export type { DodoPaymentsAdapterOptions, DodoPaymentsClientLike };
