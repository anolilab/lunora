/**
 * Polar adapter.
 *
 * Mirrors the Stripe adapter's shape — an injected, structural `PolarClientLike` (so this package
 * never imports `@polar-sh/sdk`) — but Polar is a Merchant-of-Record: there is no manual
 * authorize/capture, so those throw. Webhooks use the Standard Webhooks scheme (`webhook-id` /
 * `webhook-timestamp` / `webhook-signature`), verified by {@link verifyStandardWebhook}. Client
 * responses are SDK-camelCased; raw webhook bodies are snake_case — handled accordingly.
 */
import type { PaymentAdapter, WebhookInput } from "../adapter";
import { LunoraPaymentError } from "../errors";
import { asRecord, readBoolean, readNumber, readString } from "../json";
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
    ReportUsageInput,
    Subscription,
    SubscriptionPatch,
    SubscriptionState,
    WebhookAction,
    WebhookActionType,
} from "../types";
import { verifyStandardWebhook } from "../webhook";

interface PolarSubscriptionLike {
    readonly cancelAtPeriodEnd?: boolean;
    readonly currentPeriodEnd?: null | string;
    readonly currentPeriodStart?: null | string;
    readonly customerId?: null | string;
    readonly id: string;
    readonly metadata?: Record<string, string>;
    readonly productId?: string;
    readonly status: string;
}

interface PolarOrderLike {
    readonly amount?: number;
    readonly currency?: string;
    readonly id: string;
    readonly status: string;
    readonly totalAmount?: number;
}

interface PolarClientLike {
    readonly checkouts: { create: (parameters: Record<string, unknown>) => Promise<{ id: string; url: string }> };
    readonly customers: { create: (parameters: Record<string, unknown>) => Promise<{ email: null | string; id: string }> };
    readonly customerSessions: { create: (parameters: Record<string, unknown>) => Promise<{ customerPortalUrl: string }> };
    readonly events: { ingest: (parameters: Record<string, unknown>) => Promise<{ inserted?: number }> };
    readonly orders: { get: (parameters: Record<string, unknown>) => Promise<PolarOrderLike> };
    readonly refunds: { create: (parameters: Record<string, unknown>) => Promise<{ id: string }> };
    readonly subscriptions: {
        get: (parameters: Record<string, unknown>) => Promise<PolarSubscriptionLike>;
        revoke: (parameters: Record<string, unknown>) => Promise<PolarSubscriptionLike>;
        update: (parameters: Record<string, unknown>) => Promise<PolarSubscriptionLike>;
    };
}

interface PolarAdapterOptions {
    readonly client: PolarClientLike;
    readonly webhookSecret: string;
    readonly webhookToleranceSeconds?: number;
}

const PAYMENT_STATE_BY_POLAR_ORDER_STATUS: Record<string, PaymentState> = {
    paid: "captured",
    partially_refunded: "partially_refunded",
    pending: "initiated",
    refunded: "refunded",
};

const SUBSCRIPTION_STATE_BY_POLAR_STATUS: Record<string, SubscriptionState> = {
    active: "active",
    canceled: "canceled",
    // SECURITY: `incomplete` (first payment not completed) must not map to an
    // entitling state — see the equivalent note in the Stripe adapter. Treat it as
    // non-entitling `past_due`; reserve `trialing` for a genuine trial.
    incomplete: "past_due",
    incomplete_expired: "canceled",
    past_due: "past_due",
    trialing: "trialing",
    unpaid: "past_due",
};

const notSupported = (operation: string): never => {
    throw new LunoraPaymentError("PROVIDER_ERROR", `polar (merchant-of-record) does not support ${operation}`);
};

const parseTimestamp = (value: null | string | undefined): number | undefined => {
    const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;

    return Number.isNaN(parsed) ? undefined : parsed;
};

const subscriptionFromPolar = (subscription: PolarSubscriptionLike): Subscription => {
    const now = Date.now();

    return {
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd ?? false,
        createdAt: now,
        currentPeriodEnd: parseTimestamp(subscription.currentPeriodEnd),
        currentPeriodStart: parseTimestamp(subscription.currentPeriodStart),
        id: subscription.id,
        priceId: subscription.productId ?? "",
        provider: "polar",
        quantity: 1,
        referenceId: subscription.metadata?.referenceId ?? "",
        state: SUBSCRIPTION_STATE_BY_POLAR_STATUS[subscription.status] ?? "active",
        updatedAt: now,
    };
};

const orderToSession = (order: PolarOrderLike): PaymentSession => {
    const now = Date.now();
    const currency = order.currency ?? "usd";
    const amount = money(BigInt(order.totalAmount ?? order.amount ?? 0), currency);
    const state = PAYMENT_STATE_BY_POLAR_ORDER_STATUS[order.status] ?? "initiated";
    const settled = state === "captured" || state === "partially_refunded" || state === "refunded";

    return {
        amount,
        capturedAmount: settled ? amount : zeroMoney(currency),
        createdAt: now,
        id: order.id,
        provider: "polar",
        referenceId: "",
        refundedAmount: state === "refunded" ? amount : zeroMoney(currency),
        state,
        updatedAt: now,
    };
};

const subscriptionEventType = (status: string | undefined): WebhookActionType => {
    const state = status ? SUBSCRIPTION_STATE_BY_POLAR_STATUS[status] : undefined;

    if (state === "canceled") {
        return "subscription.canceled";
    }

    if (state === "past_due") {
        return "subscription.past_due";
    }

    if (state === "active" || state === "trialing") {
        return "subscription.active";
    }

    return "subscription.updated";
};

// Webhook bodies are raw snake_case.
const referenceFromMetadata = (object: Record<string, unknown>): string | undefined => readString(asRecord(object.metadata), "referenceId");

const mapEvent = (eventId: string, eventType: string, object: Record<string, unknown>): WebhookAction => {
    const base = { eventId, provider: "polar" as const, raw: { object, type: eventType } };
    const currency = readString(object, "currency") ?? "usd";

    switch (eventType) {
        case "order.created":
        case "order.paid": {
            return {
                ...base,
                amount: money(BigInt(readNumber(object, "total_amount") ?? readNumber(object, "amount") ?? 0), currency),
                customerId: readString(object, "customer_id"),
                referenceId: referenceFromMetadata(object),
                sessionId: readString(object, "id"),
                subscriptionId: readString(object, "subscription_id"),
                type: "payment.captured",
            };
        }

        case "refund.created": {
            return {
                ...base,
                amount: money(BigInt(readNumber(object, "amount") ?? 0), currency),
                referenceId: referenceFromMetadata(object),
                sessionId: readString(object, "order_id") ?? readString(object, "id"),
                type: "payment.refunded",
            };
        }

        case "subscription.active":
        case "subscription.canceled":
        case "subscription.created":
        case "subscription.revoked":
        case "subscription.updated": {
            const type = eventType === "subscription.revoked" ? "subscription.canceled" : subscriptionEventType(readString(object, "status"));

            return {
                ...base,
                cancelAtPeriodEnd: readBoolean(object, "cancel_at_period_end"),
                currentPeriodEnd: parseTimestamp(readString(object, "current_period_end")),
                currentPeriodStart: parseTimestamp(readString(object, "current_period_start")),
                customerId: readString(object, "customer_id"),
                priceId: readString(object, "product_id"),
                referenceId: referenceFromMetadata(object),
                subscriptionId: readString(object, "id"),
                type,
            };
        }

        default: {
            return { ...base, type: "unhandled" };
        }
    }
};

export const createPolarAdapter = (options: PolarAdapterOptions): PaymentAdapter => {
    const { client, webhookSecret } = options;

    return {
        cancelPayment: () => notSupported("manual payment cancellation"),

        cancelSubscription: async (subscriptionId, cancelOptions) => {
            const subscription = cancelOptions?.atPeriodEnd
                ? await client.subscriptions.update({ id: subscriptionId, subscriptionUpdate: { cancelAtPeriodEnd: true } })
                : await client.subscriptions.revoke({ id: subscriptionId });

            return subscriptionFromPolar(subscription);
        },

        capabilities: { merchantOfRecord: true, portal: true, usageMetering: true },

        capturePayment: (_input: CaptureInput) => notSupported("manual capture"),

        createCheckout: async (input: CheckoutInput): Promise<CheckoutResult> => {
            const checkout = await client.checkouts.create({
                customerEmail: undefined,
                // Pin the framework-controlled `referenceId` LAST so caller metadata can never override it.
                metadata: { ...input.metadata, referenceId: input.referenceId },
                products: [input.priceId],
                successUrl: input.successUrl,
            });

            return { id: checkout.id, provider: "polar", url: checkout.url };
        },

        createPortalSession: async (input: PortalInput) => {
            const session = await client.customerSessions.create({ customerId: input.customerId });

            return { url: session.customerPortalUrl };
        },

        getOrCreateCustomer: async (ref: CustomerRef): Promise<Customer> => {
            const customer = await client.customers.create({
                email: ref.email,
                externalId: ref.referenceId,
                metadata: { ...ref.metadata, referenceId: ref.referenceId },
            });

            return { createdAt: Date.now(), email: customer.email ?? undefined, id: customer.id, provider: "polar", referenceId: ref.referenceId };
        },

        getPaymentStatus: async (sessionId) => orderToSession(await client.orders.get({ id: sessionId })),

        getSubscriptionStatus: async (subscriptionId) => subscriptionFromPolar(await client.subscriptions.get({ id: subscriptionId })),

        identifier: "polar",

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

        refundPayment: async (input) => {
            await client.refunds.create({
                amount: input.amount ? Number(input.amount.minorUnits) : undefined,
                orderId: input.sessionId,
                reason: input.reason ?? "customer_request",
            });

            // Polar refunds are reported terminally; reflect the requested amount.
            const refundedAmount = input.amount ?? money(0, "usd");

            return {
                amount: refundedAmount,
                capturedAmount: refundedAmount,
                createdAt: Date.now(),
                id: input.sessionId,
                provider: "polar",
                referenceId: "",
                refundedAmount,
                state: "refunded",
                updatedAt: Date.now(),
            };
        },

        reportUsage: async (input: ReportUsageInput) => {
            // Polar event ingestion: one event per usage record, keyed to the customer by its
            // external id (the reference id we set on customer creation). Metadata carries the value.
            await client.events.ingest({
                events: [
                    {
                        externalCustomerId: input.referenceId,
                        metadata: { value: input.quantity },
                        name: input.featureId,
                        timestamp: input.timestamp === undefined ? undefined : new Date(input.timestamp).toISOString(),
                    },
                ],
            });
        },

        resumeSubscription: async (subscriptionId) => {
            const subscription = await client.subscriptions.update({ id: subscriptionId, subscriptionUpdate: { cancelAtPeriodEnd: false } });

            return subscriptionFromPolar(subscription);
        },

        updateSubscription: async (subscriptionId, patch: SubscriptionPatch) => {
            const subscription = await client.subscriptions.update({
                id: subscriptionId,
                subscriptionUpdate: patch.priceId ? { productId: patch.priceId } : {},
            });

            return subscriptionFromPolar(subscription);
        },
    };
};

export type { PolarAdapterOptions, PolarClientLike };
