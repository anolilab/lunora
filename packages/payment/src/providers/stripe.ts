/**
 * Stripe adapter.
 *
 * Takes a `Stripe` client by injection (a minimal structural `StripeClientLike`), so this
 * package never imports the `stripe` SDK — keep `stripe` as an optional peer dependency and pass
 * `new Stripe(key)` from the app. Stripe amounts are already integer minor units (zero-decimal
 * currencies included), matching money 1:1.
 */
import type { PaymentAdapter, WebhookInput } from "../adapter";
import idempotencyKey from "../idempotency";
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
    WebhookActionType,
} from "../types";
import { verifyStripeSignature } from "../webhook";

interface StripeRequestOptions {
    readonly idempotencyKey?: string;
}

interface StripePaymentIntentLike {
    readonly amount: number;
    readonly amount_received?: number;
    readonly currency: string;
    readonly customer?: null | string;
    readonly id: string;
    readonly metadata?: Record<string, string>;
    readonly status: string;
}

interface StripeSubscriptionLike {
    readonly cancel_at_period_end?: boolean;
    readonly current_period_end?: number;
    readonly current_period_start?: number;
    readonly customer?: null | string;
    readonly id: string;
    readonly items?: { data: ReadonlyArray<{ price?: { id?: string }; quantity?: number }> };
    readonly metadata?: Record<string, string>;
    readonly status: string;
}

/** The subset of the Stripe SDK surface this adapter calls. A real `Stripe` instance satisfies it. */
interface StripeClientLike {
    readonly billing: { meterEvents: { create: (parameters: Record<string, unknown>, options?: StripeRequestOptions) => Promise<{ identifier?: string }> } };
    readonly billingPortal: { sessions: { create: (parameters: Record<string, unknown>) => Promise<{ url: string }> } };
    readonly checkout: {
        sessions: { create: (parameters: Record<string, unknown>, options?: StripeRequestOptions) => Promise<{ id: string; url: null | string }> };
    };
    readonly customers: {
        create: (parameters: Record<string, unknown>, options?: StripeRequestOptions) => Promise<{ email: null | string; id: string }>;
    };
    readonly paymentIntents: {
        cancel: (id: string, parameters?: Record<string, unknown>, options?: StripeRequestOptions) => Promise<StripePaymentIntentLike>;
        capture: (id: string, parameters?: Record<string, unknown>, options?: StripeRequestOptions) => Promise<StripePaymentIntentLike>;
        retrieve: (id: string) => Promise<StripePaymentIntentLike>;
    };
    readonly refunds: { create: (parameters: Record<string, unknown>, options?: StripeRequestOptions) => Promise<{ id: string }> };
    readonly subscriptions: {
        cancel: (id: string, parameters?: Record<string, unknown>, options?: StripeRequestOptions) => Promise<StripeSubscriptionLike>;
        retrieve: (id: string) => Promise<StripeSubscriptionLike>;
        update: (id: string, parameters: Record<string, unknown>, options?: StripeRequestOptions) => Promise<StripeSubscriptionLike>;
    };
}

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

const periodEndMs = (object: Record<string, unknown>): number | undefined => {
    const seconds = readNumber(object, "current_period_end");

    return seconds === undefined ? undefined : seconds * 1000;
};

const periodStartMs = (object: Record<string, unknown>): number | undefined => {
    const seconds = readNumber(object, "current_period_start");

    return seconds === undefined ? undefined : seconds * 1000;
};

const intentToSession = (intent: StripePaymentIntentLike): PaymentSession => {
    const amount = money(BigInt(intent.amount), intent.currency);
    const state = PAYMENT_STATE_BY_STRIPE_STATUS[intent.status] ?? "initiated";
    const now = Date.now();

    return {
        amount,
        capturedAmount: state === "captured" ? money(BigInt(intent.amount_received ?? intent.amount), intent.currency) : zeroMoney(intent.currency),
        createdAt: now,
        id: intent.id,
        provider: "stripe",
        referenceId: intent.metadata?.referenceId ?? "",
        refundedAmount: zeroMoney(intent.currency),
        state,
        updatedAt: now,
    };
};

const subscriptionFromStripe = (subscription: StripeSubscriptionLike): Subscription => {
    const now = Date.now();

    return {
        cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
        createdAt: now,
        currentPeriodEnd: subscription.current_period_end ? subscription.current_period_end * 1000 : undefined,
        currentPeriodStart: subscription.current_period_start ? subscription.current_period_start * 1000 : undefined,
        id: subscription.id,
        priceId: subscription.items?.data[0]?.price?.id ?? "",
        provider: "stripe",
        quantity: subscription.items?.data[0]?.quantity ?? 1,
        referenceId: subscription.metadata?.referenceId ?? "",
        state: SUBSCRIPTION_STATE_BY_STRIPE_STATUS[subscription.status] ?? "active",
        updatedAt: now,
    };
};

const subscriptionEventType = (status: string | undefined): WebhookActionType => {
    const state = status ? SUBSCRIPTION_STATE_BY_STRIPE_STATUS[status] : undefined;

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
                amount: money(BigInt(readNumber(object, "amount_refunded") ?? 0), currency),
                amountKind: "absolute",
                referenceId: readReferenceId(object),
                sessionId: readString(object, "payment_intent") ?? readString(object, "id"),
                type: "payment.refunded",
            };
        }

        case "checkout.session.completed": {
            if (readString(object, "mode") === "subscription") {
                // SECURITY: a completed subscription checkout is only ACTIVE when
                // Stripe confirms it was paid (or no payment was required). An
                // `unpaid` session (async payment still processing) must not grant
                // entitlements — emit a non-entitling `subscription.updated` (a
                // metadata patch that no-ops without an existing row); the
                // authoritative active state still arrives via `customer.subscription.*`.
                // Only promote to ACTIVE when Stripe EXPLICITLY confirms payment.
                // An `unpaid` session (async payment still processing) — or a
                // missing/unknown `payment_status` — must NOT entitle; fail closed.
                const paymentStatus = readString(object, "payment_status");
                const paid = paymentStatus === "paid" || paymentStatus === "no_payment_required";

                return {
                    ...base,
                    customerId: readString(object, "customer"),
                    referenceId: readReferenceId(object),
                    subscriptionId: readString(object, "subscription"),
                    type: paid ? "subscription.active" : "subscription.updated",
                };
            }

            const amountTotal = readNumber(object, "amount_total");

            return {
                ...base,
                amount: amountTotal === undefined ? undefined : money(BigInt(amountTotal), currency),
                customerId: readString(object, "customer"),
                referenceId: readReferenceId(object),
                sessionId: readString(object, "payment_intent") ?? readString(object, "id"),
                type: "payment.captured",
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
                type: subscriptionEventType(readString(object, "status")),
            };
        }

        case "customer.subscription.deleted": {
            return { ...base, referenceId: readReferenceId(object), subscriptionId: readString(object, "id"), type: "subscription.canceled" };
        }

        case "payment_intent.amount_capturable_updated": {
            return {
                ...base,
                amount: money(BigInt(readNumber(object, "amount") ?? 0), currency),
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
                amount: money(BigInt(readNumber(object, "amount_received") ?? readNumber(object, "amount") ?? 0), currency),
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

export const createStripeAdapter = (options: StripeAdapterOptions): PaymentAdapter => {
    const { client, webhookSecret } = options;

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
            const signatureHeader = headers.get("stripe-signature") ?? "";

            await verifyStripeSignature({ payload, secret: webhookSecret, signatureHeader, toleranceSeconds: options.webhookToleranceSeconds });

            const event = asRecord(JSON.parse(payload));
            const object = asRecord(asRecord(event.data).object);

            return mapEvent(readString(event, "id") ?? "", readString(event, "type") ?? "", object);
        },

        refundPayment: async (input: RefundInput) => {
            await client.refunds.create(
                {
                    amount: input.amount ? Number(input.amount.minorUnits) : undefined,
                    payment_intent: input.sessionId,
                    reason: input.reason,
                },
                { idempotencyKey: input.idempotencyKey },
            );

            const intent = await client.paymentIntents.retrieve(input.sessionId);
            const session = intentToSession(intent);
            const refundedAmount = input.amount ?? session.capturedAmount;
            const partial = input.amount !== undefined && compareMoney(input.amount, session.capturedAmount) < 0;

            return { ...session, refundedAmount, state: partial ? "partially_refunded" : "refunded" };
        },

        reportUsage: async (input: ReportUsageInput) => {
            // Stripe v2 Meter Events: `event_name` is the meter, `value` a string, `identifier`
            // dedupes within the meter's aggregation window. Keyed on the Stripe customer id.
            await client.billing.meterEvents.create(
                {
                    event_name: input.featureId,
                    identifier: input.idempotencyKey,
                    payload: { stripe_customer_id: input.customerId, value: String(input.quantity) },
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
            const parameters: Record<string, unknown> = {};

            if (patch.quantity !== undefined) {
                parameters.quantity = patch.quantity;
            }

            if (patch.priceId) {
                parameters.items = [{ price: patch.priceId }];
            }

            const subscription = await client.subscriptions.update(subscriptionId, parameters);

            return subscriptionFromStripe(subscription);
        },
    };
};

export type { StripeAdapterOptions, StripeClientLike };
