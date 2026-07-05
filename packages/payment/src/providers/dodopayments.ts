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
import type { PaymentAdapter, WebhookInput } from "../adapter";
import { LunoraPaymentError } from "../errors";
import idempotencyKey from "../idempotency";
import { asRecord, parseTimestamp, readBoolean, readNumber, readString } from "../json";
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
    WebhookActionType,
} from "../types";
import { verifyStandardWebhook } from "../webhook";

/** The subset of the Dodo Payments SDK surface this adapter calls. A real `DodoPayments` satisfies it. */
interface DodoPaymentsClientLike {
    readonly checkoutSessions: {
        readonly create: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    readonly customers: {
        readonly create: (body: Record<string, unknown>, options?: { idempotencyKey?: string }) => Promise<Record<string, unknown>>;
        readonly customerPortal: {
            readonly create: (customerId: string, body?: Record<string, unknown>) => Promise<Record<string, unknown>>;
        };
    };
    readonly payments: {
        readonly retrieve: (paymentId: string) => Promise<Record<string, unknown>>;
    };
    readonly refunds: {
        readonly create: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    readonly subscriptions: {
        readonly changePlan: (subscriptionId: string, body: Record<string, unknown>) => Promise<unknown>;
        readonly retrieve: (subscriptionId: string) => Promise<Record<string, unknown>>;
        readonly update: (subscriptionId: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    readonly usageEvents: {
        readonly ingest: (body: Record<string, unknown>) => Promise<unknown>;
    };
}

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
    pending: "past_due",
};

const notSupported = (operation: string): never => {
    throw new LunoraPaymentError("PROVIDER_ERROR", `dodopayments (merchant-of-record) does not support ${operation}`);
};

/** Dodo nests the reference under the object's `metadata`; we pin it there on checkout. */
const referenceFromMetadata = (object: Record<string, unknown>): string | undefined => readString(asRecord(object.metadata), "referenceId");

const customerIdOf = (object: Record<string, unknown>): string | undefined =>
    readString(asRecord(object.customer), "customer_id") ?? readString(object, "customer_id");

const subscriptionFromDodo = (subscription: Record<string, unknown>): Subscription => {
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

const paymentFromDodo = (payment: Record<string, unknown>): PaymentSession => {
    const now = Date.now();
    const currency = readString(payment, "currency") ?? "usd";
    const amount = money(BigInt(readNumber(payment, "total_amount") ?? 0), currency);
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

const subscriptionEventType = (status: string | undefined): WebhookActionType => {
    const state = status ? SUBSCRIPTION_STATE_BY_DODO_STATUS[status] : undefined;

    if (state === "canceled") {
        return "subscription.canceled";
    }

    if (state === "past_due") {
        return "subscription.past_due";
    }

    if (state === "active") {
        return "subscription.active";
    }

    return "subscription.updated";
};

const mapEvent = (eventId: string, eventType: string, object: Record<string, unknown>): WebhookAction => {
    const base = { eventId, provider: "dodopayments" as const, raw: { object, type: eventType } };
    const currency = readString(object, "currency") ?? "usd";

    switch (eventType) {
        // A cancelled payment never settled — record it as a non-entitling failure (there is no
        // dedicated `payment.canceled` action; `failed` is the closest terminal, non-entitling state).
        case "payment.cancelled":
        case "payment.failed": {
            return { ...base, referenceId: referenceFromMetadata(object), sessionId: readString(object, "payment_id"), type: "payment.failed" };
        }
        case "payment.succeeded": {
            return {
                ...base,
                amount: money(BigInt(readNumber(object, "total_amount") ?? 0), currency),
                customerId: customerIdOf(object),
                referenceId: referenceFromMetadata(object),
                sessionId: readString(object, "payment_id"),
                subscriptionId: readString(object, "subscription_id"),
                type: "payment.captured",
            };
        }

        case "refund.succeeded": {
            return {
                ...base,
                amount: money(BigInt(readNumber(object, "amount") ?? 0), currency),
                referenceId: referenceFromMetadata(object),
                sessionId: readString(object, "payment_id"),
                type: "payment.refunded",
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
            const status = readString(object, "status");

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
                type: subscriptionEventType(status),
            };
        }

        default: {
            // payment.processing, refund.failed, dispute.*, license_key.* — no state transition here.
            return { ...base, type: "unhandled" };
        }
    }
};

export const createDodoPaymentsAdapter = (options: DodoPaymentsAdapterOptions): PaymentAdapter => {
    const { client, webhookSecret } = options;

    return {
        // Dodo is a Merchant-of-Record: it moves the money, so there is no manual payment-intent
        // authorize/capture/cancel. Refunds, however, are supported below.
        cancelPayment: () => notSupported("manual payment cancellation"),

        cancelSubscription: async (subscriptionId, cancelOptions) => {
            // Same endpoint either way — only the body differs (schedule vs. immediate).
            const body = cancelOptions?.atPeriodEnd ? { cancel_at_next_billing_date: true } : { status: "cancelled" };

            return subscriptionFromDodo(await client.subscriptions.update(subscriptionId, body));
        },

        capabilities: { merchantOfRecord: true, portal: true, usageMetering: true },

        capturePayment: (_input: CaptureInput) => notSupported("manual capture"),

        createCheckout: async (input: CheckoutInput): Promise<CheckoutResult> => {
            const session = await client.checkoutSessions.create({
                // An existing Dodo customer is attached by id; otherwise Dodo collects one at checkout.
                customer: input.customerId ? { customer_id: input.customerId } : undefined,
                // Pin the framework-controlled `referenceId` LAST so caller metadata can never override it.
                metadata: { ...input.metadata, referenceId: input.referenceId },
                product_cart: [{ product_id: input.priceId, quantity: input.quantity ?? 1 }],
                return_url: input.successUrl,
            });

            return { id: readString(session, "session_id") ?? "", provider: "dodopayments", url: readString(session, "checkout_url") ?? "" };
        },

        createPortalSession: async (input: PortalInput) => {
            const session = await client.customers.customerPortal.create(input.customerId, { return_url: input.returnUrl });

            return { url: readString(session, "link") ?? readString(session, "url") ?? "" };
        },

        getOrCreateCustomer: async (ref: CustomerRef): Promise<Customer> => {
            // Dodo's `customers.create` is NOT idempotent by email, so a retried/raced first checkout
            // for the same reference would mint duplicate customers. Key the create on the reference so
            // repeats return the same customer (the facade also gates this behind a store lookup).
            const customer = await client.customers.create(
                { email: ref.email, name: ref.metadata?.name ?? ref.referenceId },
                { idempotencyKey: idempotencyKey("customer", "dodopayments", ref.referenceId) },
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
            const refund = await client.refunds.create({
                amount: input.amount ? Number(input.amount.minorUnits) : undefined,
                payment_id: input.sessionId,
                reason: input.reason,
            });
            const currency = readString(refund, "currency") ?? input.amount?.currency ?? "usd";
            const refundedAmount = input.amount ?? money(BigInt(readNumber(refund, "amount") ?? 0), currency);

            return {
                amount: refundedAmount,
                capturedAmount: refundedAmount,
                createdAt: Date.now(),
                id: input.sessionId,
                provider: "dodopayments",
                referenceId: "",
                refundedAmount,
                state: "refunded",
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
