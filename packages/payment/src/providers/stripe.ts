/**
 * Stripe adapter.
 *
 * Takes a `Stripe` client by injection — `stripe` is an optional peer dependency, so pass
 * `new Stripe(key, { httpClient: Stripe.createFetchHttpClient() })` from the app (the fetch HTTP
 * client is required on workerd). The public `client` is typed as the small structural
 * {@link StripeClientLike} (a real `Stripe` instance satisfies it, no cast) to keep the published
 * declarations lean; internally it is used as the real `Stripe` type so every call is checked
 * against the SDK, and webhooks are verified with the SDK's own `webhooks.constructEventAsync`.
 * Stripe amounts are already integer minor units (zero-decimal currencies included), matching money 1:1.
 */
import type { Stripe } from "stripe";

import type { PaymentAdapter, WebhookInput } from "../adapter";
import { LunoraPaymentError } from "../errors";
import { idempotencyKey } from "../idempotency";
import { asRecord, readBoolean, readNumber, readString } from "../json";
import { compareMoney, money, zeroMoney } from "../money";
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
import { assertWebhookSecret } from "../webhook";
import stateToEventType from "./subscription-event";

/**
 * The Stripe SDK surface the adapter uses, as a structural type — a real `Stripe` instance satisfies
 * it without a cast. Resources are `unknown` here (the adapter re-types the client as the real
 * `Stripe` internally); this keeps the SDK's full type out of the published declaration files.
 * @experimental
 */
interface StripeClientLike {
    readonly billing: unknown;
    readonly billingPortal: unknown;
    readonly checkout: unknown;
    readonly customers: unknown;
    readonly paymentIntents: unknown;
    readonly refunds: unknown;
    readonly subscriptions: unknown;
    readonly webhooks: unknown;
}

/**
 * `StripeAdapterOptions` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
interface StripeAdapterOptions {
    readonly client: StripeClientLike;
    readonly webhookSecret: string;
    readonly webhookToleranceSeconds?: number;
}

const PAYMENT_STATE_BY_STRIPE_STATUS: Record<string, PaymentState> = {
    canceled: "canceled",
    processing: "authorized",
    requires_action: "authorized",
    requires_capture: "authorized",
    requires_confirmation: "initiated",
    requires_payment_method: "initiated",
    succeeded: "captured",
};

const SUBSCRIPTION_STATE_BY_STRIPE_STATUS: Record<string, SubscriptionState> = {
    active: "active",
    canceled: "canceled",
    // SECURITY: `incomplete` means the FIRST payment has not succeeded (SCA
    // `requires_action` or a failed initial charge). It must NOT map to an
    // entitling state — Stripe's recommended `payment_behavior: "default_incomplete"`
    // makes `incomplete` the initial status of every new subscription, so mapping
    // it to `trialing` (which is in ACTIVE_STATES) would grant paid entitlements
    // before any payment. Reserve `trialing` for a genuine Stripe trial (status
    // `trialing`, mapped below); treat `incomplete` as non-entitling `past_due`.
    incomplete: "past_due",
    incomplete_expired: "canceled",
    past_due: "past_due",
    paused: "paused",
    trialing: "trialing",
    unpaid: "past_due",
};

const readReferenceId = (object: Record<string, unknown>): string | undefined =>
    readString(asRecord(object.metadata), "referenceId") ?? readString(object, "client_reference_id");

const firstItem = (object: Record<string, unknown>): Record<string, unknown> => {
    const items = asRecord(object.items);
    const data = Array.isArray(items.data) ? items.data : [];

    return asRecord(data[0]);
};

const firstPriceId = (object: Record<string, unknown>): string | undefined => readString(asRecord(firstItem(object).price), "id");

const firstQuantity = (object: Record<string, unknown>): number | undefined => readNumber(firstItem(object), "quantity");

// The current billing period moved from the top-level Subscription to the subscription item in
// Stripe API 2025-03-31.basil (`items.data[].current_period_*`). Read the item first, falling back
// to the top level for apps pinned to an older API version.
const periodEndMs = (object: Record<string, unknown>): number | undefined => {
    const seconds = readNumber(firstItem(object), "current_period_end") ?? readNumber(object, "current_period_end");

    return seconds === undefined ? undefined : seconds * 1000;
};

const periodStartMs = (object: Record<string, unknown>): number | undefined => {
    const seconds = readNumber(firstItem(object), "current_period_start") ?? readNumber(object, "current_period_start");

    return seconds === undefined ? undefined : seconds * 1000;
};

/** Normalize a Stripe PaymentIntent (typed return read defensively) into a {@link PaymentSession}. */
const intentToSession = (input: unknown): PaymentSession => {
    const intent = asRecord(input);
    const currency = readString(intent, "currency") ?? "usd";
    const amountValue = readNumber(intent, "amount") ?? 0;
    const amount = money(BigInt(Math.round(amountValue)), currency);
    const state = PAYMENT_STATE_BY_STRIPE_STATUS[readString(intent, "status") ?? ""] ?? "initiated";
    const now = Date.now();

    return {
        amount,
        capturedAmount: state === "captured" ? money(BigInt(Math.round(readNumber(intent, "amount_received") ?? amountValue)), currency) : zeroMoney(currency),
        createdAt: now,
        id: readString(intent, "id") ?? "",
        provider: "stripe",
        referenceId: readReferenceId(intent) ?? "",
        refundedAmount: zeroMoney(currency),
        state,
        updatedAt: now,
    };
};

/** Normalize a Stripe Subscription (typed return read defensively) into a {@link Subscription}. */
const subscriptionFromStripe = (input: unknown): Subscription => {
    const subscription = asRecord(input);
    const now = Date.now();

    return {
        cancelAtPeriodEnd: readBoolean(subscription, "cancel_at_period_end") ?? false,
        createdAt: now,
        currentPeriodEnd: periodEndMs(subscription),
        currentPeriodStart: periodStartMs(subscription),
        id: readString(subscription, "id") ?? "",
        priceId: firstPriceId(subscription) ?? "",
        provider: "stripe",
        quantity: firstQuantity(subscription) ?? 1,
        referenceId: readReferenceId(subscription) ?? "",
        // Fail closed: an unrecognized Stripe status is treated as non-entitling `past_due`.
        state: SUBSCRIPTION_STATE_BY_STRIPE_STATUS[readString(subscription, "status") ?? ""] ?? "past_due",
        updatedAt: now,
    };
};

const mapEvent = (eventId: string, eventType: string, object: Record<string, unknown>): WebhookAction => {
    const base = { eventId, provider: "stripe" as const, raw: { object, type: eventType } };
    const currency = readString(object, "currency") ?? "usd";

    switch (eventType) {
        case "charge.refunded": {
            // Stripe's `amount_refunded` is the CUMULATIVE refunded-to-date total (it already sums
            // every prior partial refund), not this event's delta. Tag it `"absolute"` so the sync
            // layer sets — rather than adds — the running refunded total and never over-counts.
            return {
                ...base,
                amount: money(BigInt(Math.round(readNumber(object, "amount_refunded") ?? 0)), currency),
                amountKind: "absolute",
                referenceId: readReferenceId(object),
                sessionId: readString(object, "payment_intent") ?? readString(object, "id"),
                type: "payment.refunded",
            };
        }

        case "checkout.session.async_payment_failed": {
            // The delayed debit was returned. For a payment the provisional `authorized` row fails;
            // for a subscription the invoice behind the checkout never settled, so demote it to the
            // non-entitling `past_due` and raise the dunning signal. A row already `past_due` (the
            // usual case — `customer.subscription.created` arrives `incomplete`) is a no-op report.
            if (readString(object, "mode") === "subscription") {
                return {
                    ...base,
                    customerId: readString(object, "customer"),
                    referenceId: readReferenceId(object),
                    subscriptionId: readString(object, "subscription"),
                    type: "subscription.past_due",
                };
            }

            return {
                ...base,
                referenceId: readReferenceId(object),
                sessionId: readString(object, "payment_intent") ?? readString(object, "id"),
                type: "payment.failed",
            };
        }

        // A delayed-notification method (SEPA debit, ACH, Boleto, OXXO, Konbini) completes the
        // session BEFORE the money settles — `payment_status: "unpaid"`, PaymentIntent `processing` —
        // and settlement is signalled days later by `async_payment_succeeded` / `async_payment_failed`.
        // Both settlement events carry the same Checkout Session object as `completed`, so they share
        // this mapping and `payment_status` decides the transition for all three.
        case "checkout.session.async_payment_succeeded":
        case "checkout.session.completed": {
            // SECURITY: money has only moved when Stripe says so. An `unpaid` session — or a
            // missing/unknown `payment_status` — must never be recorded as captured or entitling;
            // both branches below fail closed to a non-entitling, still-advanceable state.
            const paymentStatus = readString(object, "payment_status");
            const paid = paymentStatus === "paid" || paymentStatus === "no_payment_required";

            if (readString(object, "mode") === "subscription") {
                // Fail closed to a non-entitling `subscription.updated` (a no-op metadata patch); the
                // authoritative active state still arrives via `customer.subscription.*`.
                return {
                    ...base,
                    customerId: readString(object, "customer"),
                    referenceId: readReferenceId(object),
                    subscriptionId: readString(object, "subscription"),
                    type: paid ? "subscription.active" : "subscription.updated",
                };
            }

            const paymentIntentId = readString(object, "payment_intent");

            // Async payment methods can complete the session before a payment_intent id is
            // attached. Capturing under the cs_… id here and the pi_… id on the later
            // payment_intent.succeeded would create two rows for one payment — defer to
            // payment_intent.succeeded, the authoritative capture, instead.
            //
            // Only when an intent is actually coming, though: a fully discounted session settles as
            // `no_payment_required` and Stripe creates NO PaymentIntent for it, so deferring would
            // drop the order entirely and an app fulfilling off `paymentSessions` would silently stop
            // serving free orders. Those keep the cs_… id — the only id that payment ever has.
            if (paymentIntentId === undefined && paymentStatus !== "no_payment_required") {
                return { ...base, type: "unhandled" };
            }

            const amountTotal = readNumber(object, "amount_total");

            return {
                ...base,
                amount: amountTotal === undefined ? undefined : money(BigInt(Math.round(amountTotal)), currency),
                customerId: readString(object, "customer"),
                referenceId: readReferenceId(object),
                sessionId: paymentIntentId ?? readString(object, "id"),
                // An unsettled session is `authorized`, the same state a `processing` PaymentIntent
                // maps to — so `reconcile` agrees with the webhook — and the FSM keeps both exits
                // open from there (`capture` on settlement, `fail` on a return). Recording it as
                // captured is the one thing that cannot be undone: `captured` has no `fail` edge, by
                // design, so a returned debit would leave the row captured forever.
                type: paid ? "payment.captured" : "payment.authorized",
            };
        }

        case "customer.subscription.created":
        case "customer.subscription.updated": {
            return {
                ...base,
                cancelAtPeriodEnd: readBoolean(object, "cancel_at_period_end"),
                currentPeriodEnd: periodEndMs(object),
                currentPeriodStart: periodStartMs(object),
                customerId: readString(object, "customer"),
                priceId: firstPriceId(object),
                quantity: firstQuantity(object),
                referenceId: readReferenceId(object),
                subscriptionId: readString(object, "id"),
                // Fail closed BEFORE `stateToEventType`: an unmapped status reaching it as `undefined`
                // degrades to `subscription.updated`, a metadata patch that PRESERVES an existing
                // `active` row — the same fail-open the snapshot mapper above closes.
                type: stateToEventType(SUBSCRIPTION_STATE_BY_STRIPE_STATUS[readString(object, "status") ?? ""] ?? "past_due"),
            };
        }

        case "customer.subscription.deleted": {
            return { ...base, referenceId: readReferenceId(object), subscriptionId: readString(object, "id"), type: "subscription.canceled" };
        }

        case "payment_intent.amount_capturable_updated": {
            return {
                ...base,
                amount: money(BigInt(Math.round(readNumber(object, "amount") ?? 0)), currency),
                referenceId: readReferenceId(object),
                sessionId: readString(object, "id"),
                type: "payment.authorized",
            };
        }

        case "payment_intent.payment_failed": {
            return { ...base, referenceId: readReferenceId(object), sessionId: readString(object, "id"), type: "payment.failed" };
        }

        case "payment_intent.succeeded": {
            return {
                ...base,
                amount: money(BigInt(Math.round(readNumber(object, "amount_received") ?? readNumber(object, "amount") ?? 0)), currency),
                customerId: readString(object, "customer"),
                referenceId: readReferenceId(object),
                sessionId: readString(object, "id"),
                type: "payment.captured",
            };
        }

        default: {
            return { ...base, type: "unhandled" };
        }
    }
};

/**
 * `createStripeAdapter` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export const createStripeAdapter = (options: StripeAdapterOptions): PaymentAdapter => {
    const { webhookSecret } = options;
    // Use the injected client as the real `Stripe` internally so every call below is checked against
    // the SDK (drift-proof), while the public `client` param stays the lean structural shim.
    const client = options.client as unknown as Stripe;

    return {
        cancelPayment: async (sessionId, paymentOptions) => {
            const intent = await client.paymentIntents.cancel(sessionId, undefined, { idempotencyKey: paymentOptions?.idempotencyKey });

            return intentToSession(intent);
        },

        cancelSubscription: async (subscriptionId, cancelOptions) => {
            const subscription = cancelOptions?.atPeriodEnd
                ? await client.subscriptions.update(subscriptionId, { cancel_at_period_end: true }, { idempotencyKey: cancelOptions.idempotencyKey })
                : await client.subscriptions.cancel(subscriptionId, undefined, { idempotencyKey: cancelOptions?.idempotencyKey });

            return subscriptionFromStripe(subscription);
        },

        capabilities: { merchantOfRecord: false, portal: true, usageMetering: true },

        capturePayment: async (input: CaptureInput) => {
            const intent = await client.paymentIntents.capture(
                input.sessionId,
                input.amount ? { amount_to_capture: Number(input.amount.minorUnits) } : undefined,
                { idempotencyKey: input.idempotencyKey },
            );

            return intentToSession(intent);
        },

        createCheckout: async (input: CheckoutInput): Promise<CheckoutResult> => {
            const session = await client.checkout.sessions.create(
                {
                    cancel_url: input.cancelUrl,
                    client_reference_id: input.referenceId,
                    customer: input.customerId,
                    line_items: [{ price: input.priceId, quantity: input.quantity ?? 1 }],
                    // Pin the framework-controlled `referenceId` LAST so caller metadata can never override it.
                    metadata: { ...input.metadata, referenceId: input.referenceId },
                    mode: input.mode,
                    subscription_data: input.mode === "subscription" ? { metadata: { referenceId: input.referenceId } } : undefined,
                    success_url: input.successUrl,
                },
                { idempotencyKey: input.idempotencyKey },
            );

            return { id: session.id, provider: "stripe", url: session.url ?? "" };
        },

        createPortalSession: async (input: PortalInput) => {
            const session = await client.billingPortal.sessions.create({ customer: input.customerId, return_url: input.returnUrl });

            return { url: session.url };
        },

        getOrCreateCustomer: async (ref: CustomerRef): Promise<Customer> => {
            const customer = await client.customers.create(
                { email: ref.email, metadata: { ...ref.metadata, referenceId: ref.referenceId } },
                { idempotencyKey: idempotencyKey("customer", "stripe", ref.referenceId) },
            );

            return { createdAt: Date.now(), email: customer.email ?? undefined, id: customer.id, provider: "stripe", referenceId: ref.referenceId };
        },

        getPaymentStatus: async (sessionId) => intentToSession(await client.paymentIntents.retrieve(sessionId)),

        getSubscriptionStatus: async (subscriptionId) => subscriptionFromStripe(await client.subscriptions.retrieve(subscriptionId)),

        identifier: "stripe",

        parseWebhook: async ({ headers, payload }: WebhookInput): Promise<WebhookAction> => {
            // The Stripe SDK does not check the secret itself, so a bound-but-empty
            // `STRIPE_WEBHOOK_SECRET` would verify against an attacker-known zero-length key.
            assertWebhookSecret(webhookSecret);

            const signatureHeader = headers.get("stripe-signature") ?? "";

            let event: Stripe.Event;

            try {
                // The SDK's own verification: HMAC over the raw body + timestamp tolerance. It selects
                // its crypto provider from the loaded platform build — SubtleCrypto (WebCrypto) on
                // workerd, Node crypto on Node — so no explicit provider (or value `import`) is needed.
                event = await client.webhooks.constructEventAsync(payload, signatureHeader, webhookSecret, options.webhookToleranceSeconds);
            } catch (error) {
                throw new LunoraPaymentError("WEBHOOK_SIGNATURE_INVALID", error instanceof Error ? error.message : "invalid webhook signature");
            }

            const object = asRecord(asRecord(event.data).object);

            return mapEvent(event.id, event.type, object);
        },

        refundPayment: async (input: RefundInput) => {
            const refund = await client.refunds.create(
                {
                    amount: input.amount ? Number(input.amount.minorUnits) : undefined,
                    payment_intent: input.sessionId,
                    reason: input.reason as Stripe.RefundCreateParams.Reason | undefined,
                },
                { idempotencyKey: input.idempotencyKey },
            );

            const intent = await client.paymentIntents.retrieve(input.sessionId);
            const session = intentToSession(intent);
            const refundedAmount = input.amount ?? session.capturedAmount;
            const partial = input.amount !== undefined && compareMoney(input.amount, session.capturedAmount) < 0;

            return { ...session, refundedAmount, refundId: refund.id, state: partial ? "partially_refunded" : "refunded" };
        },

        reportUsage: async (input: ReportUsageInput) => {
            // Stripe v2 Meter Events: `event_name` is the meter, `value` a string, `identifier`
            // dedupes within the meter's aggregation window. Keyed on the Stripe customer id.
            await client.billing.meterEvents.create(
                {
                    event_name: input.featureId,
                    identifier: input.idempotencyKey,
                    payload: { stripe_customer_id: input.customerId ?? "", value: String(input.quantity) },
                    timestamp: input.timestamp === undefined ? undefined : Math.floor(input.timestamp / 1000),
                },
                { idempotencyKey: input.idempotencyKey },
            );
        },

        resumeSubscription: async (subscriptionId) => {
            const subscription = await client.subscriptions.update(subscriptionId, { cancel_at_period_end: false });

            return subscriptionFromStripe(subscription);
        },

        updateSubscription: async (subscriptionId, patch: SubscriptionPatch) => {
            // Stripe updates price/quantity on the subscription ITEM, not the subscription root. Carry the
            // current item id so a plan-only or quantity-only patch updates the existing item in place.
            const parameters: Stripe.SubscriptionUpdateParams = {};

            if (patch.priceId !== undefined || patch.quantity !== undefined) {
                const current = await client.subscriptions.retrieve(subscriptionId);

                parameters.items = [{ id: current.items.data[0]?.id, price: patch.priceId, quantity: patch.quantity }];
            }

            const subscription = await client.subscriptions.update(subscriptionId, parameters);

            return subscriptionFromStripe(subscription);
        },
    };
};

export type { StripeAdapterOptions, StripeClientLike };
