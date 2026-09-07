/**
 * Polar adapter.
 *
 * Polar is a Merchant-of-Record: there is no manual authorize/capture, so those throw. The public
 * `client` is the small structural {@link PolarClientLike} (a real `@polar-sh/sdk` `Polar` instance
 * satisfies it with no cast); internally it is used as the real `Polar`, so every call is checked
 * against the SDK. Webhooks use the Standard Webhooks scheme (`webhook-id` / `webhook-timestamp` /
 * `webhook-signature`), verified by {@link verifyStandardWebhook}. Client responses are camelCase
 * (period fields are `Date`s); raw webhook bodies are snake_case — handled accordingly.
 */
import type { Polar } from "@polar-sh/sdk";

import type { PaymentAdapter, WebhookInput } from "../adapter";
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
 * The `@polar-sh/sdk` surface the adapter uses, as a structural type — a real `Polar` instance
 * satisfies it without a cast. Resources are `unknown` (the adapter re-types the client as the real
 * `Polar` internally); this keeps the SDK's full type out of the published declarations.
 * @experimental
 */
interface PolarClientLike {
    readonly checkouts: unknown;
    readonly customers: unknown;
    readonly customerSessions: unknown;
    readonly events: unknown;
    readonly orders: unknown;
    readonly refunds: unknown;
    readonly subscriptions: unknown;
}

/**
 * `PolarAdapterOptions` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
interface PolarAdapterOptions {
    readonly client: PolarClientLike;
    readonly webhookSecret: string;
    readonly webhookToleranceSeconds?: number;
}

/** Polar client responses carry `Date` period fields; webhook bodies carry ISO strings. Handle both. */
const toEpochMs = (value: unknown): number | undefined => {
    if (value instanceof Date) {
        return value.getTime();
    }

    return parseTimestamp(typeof value === "string" ? value : undefined);
};

const PAYMENT_STATE_BY_POLAR_ORDER_STATUS: Record<string, PaymentState> = {
    draft: "initiated",
    paid: "captured",
    partially_refunded: "partially_refunded",
    pending: "initiated",
    refunded: "refunded",
    void: "canceled",
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

const notSupported = makeNotSupported("polar (merchant-of-record)");

const subscriptionFromPolar = (input: unknown): Subscription => {
    const subscription = asRecord(input);
    const now = Date.now();

    return {
        cancelAtPeriodEnd: readBoolean(subscription, "cancelAtPeriodEnd") ?? false,
        createdAt: now,
        currentPeriodEnd: toEpochMs(subscription.currentPeriodEnd),
        currentPeriodStart: toEpochMs(subscription.currentPeriodStart),
        id: readString(subscription, "id") ?? "",
        priceId: readString(subscription, "productId") ?? "",
        provider: "polar",
        quantity: 1,
        referenceId: referenceFromMetadata(subscription) ?? "",
        // Fail closed: an unrecognized Polar status is treated as non-entitling `past_due`.
        state: SUBSCRIPTION_STATE_BY_POLAR_STATUS[readString(subscription, "status") ?? ""] ?? "past_due",
        updatedAt: now,
    };
};

const orderToSession = (input: unknown): PaymentSession => {
    const order = asRecord(input);
    const now = Date.now();
    const currency = readString(order, "currency") ?? "usd";
    const amount = money(BigInt(Math.round(readNumber(order, "totalAmount") ?? readNumber(order, "amount") ?? 0)), currency);
    const state = PAYMENT_STATE_BY_POLAR_ORDER_STATUS[readString(order, "status") ?? ""] ?? "initiated";
    const settled = state === "captured" || state === "partially_refunded" || state === "refunded";

    return {
        amount,
        capturedAmount: settled ? amount : zeroMoney(currency),
        createdAt: now,
        id: readString(order, "id") ?? "",
        provider: "polar",
        // Polar copies checkout metadata onto the order, so recover the framework-pinned `referenceId`
        // rather than blanking it — a reconcile sweep would otherwise orphan the row from `by_reference`.
        referenceId: referenceFromMetadata(order) ?? "",
        refundedAmount: state === "refunded" ? amount : zeroMoney(currency),
        state,
        updatedAt: now,
    };
};

// Webhook bodies are raw snake_case.
const mapEvent = (eventId: string, eventType: string, object: Record<string, unknown>): WebhookAction => {
    const base = { eventId, provider: "polar" as const, raw: { object, type: eventType } };
    const currency = readString(object, "currency") ?? "usd";

    switch (eventType) {
        case "order.created":
        case "order.paid": {
            // `order.paid` is definitionally settled. `order.created` also fires for not-yet-paid orders
            // (e.g. a pending subscription renewal), so for it require a settled `status` before emitting
            // a capture — a still-pending order is a no-op, and the later `order.paid` is the settle signal.
            if (eventType === "order.created" && PAYMENT_STATE_BY_POLAR_ORDER_STATUS[readString(object, "status") ?? ""] !== "captured") {
                return { ...base, type: "unhandled" };
            }

            return {
                ...base,
                // Raw webhook minor units go to `money()` unconverted: `BigInt()` on a fractional or
                // non-finite amount throws a bare RangeError past the adapter boundary, while `money()`
                // rejects it as a VALIDATION_ERROR the caller can actually handle.
                amount: money(readNumber(object, "total_amount") ?? readNumber(object, "amount") ?? 0, currency),
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
                amount: money(readNumber(object, "amount") ?? 0, currency),
                referenceId: referenceFromMetadata(object),
                // The event object IS the refund, so its `id` is this refund's id — the identity the
                // sync layer matches against the marker `refundPayment` left for its own refund.
                refundId: readString(object, "id"),
                sessionId: readString(object, "order_id") ?? readString(object, "id"),
                type: "payment.refunded",
            };
        }

        case "subscription.active":
        case "subscription.canceled":
        case "subscription.created":
        case "subscription.revoked":
        case "subscription.uncanceled":
        case "subscription.updated": {
            const type =
                eventType === "subscription.revoked"
                    ? "subscription.canceled"
                    : // Fail closed before `stateToEventType` — see the equivalent note in the Stripe
                      // adapter: an unmapped status must not degrade to a state-preserving metadata patch.
                      stateToEventType(SUBSCRIPTION_STATE_BY_POLAR_STATUS[readString(object, "status") ?? ""] ?? "past_due");

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

/**
 * `createPolarAdapter` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export const createPolarAdapter = (options: PolarAdapterOptions): PaymentAdapter => {
    const { webhookSecret } = options;
    // Use the injected client as the real `Polar` internally so every call is checked against the SDK.
    const client = options.client as unknown as Polar;

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
                // Bind the checkout to the customer the facade already reused/minted for this reference,
                // else Polar mints a SECOND orphan customer at completion (leaving the stored customer
                // with no subscription — its portal empty, its metered usage misrouted). `externalCustomerId`
                // carries our reference for the direct-adapter path; `customerEmail` pre-fills when neither is known.
                customerEmail: input.customerId ? undefined : input.email,
                customerId: input.customerId,
                externalCustomerId: input.referenceId,
                // Pin the framework-controlled `referenceId` LAST so caller metadata can never override it.
                metadata: { ...input.metadata, referenceId: input.referenceId },
                products: [input.priceId],
                // Polar shows a back button to this URL; map the caller's cancel URL onto it.
                returnUrl: input.cancelUrl,
                successUrl: input.successUrl,
            });

            return { id: checkout.id, provider: "polar", url: checkout.url };
        },

        createPortalSession: async (input: PortalInput) => {
            const session = await client.customerSessions.create({ customerId: input.customerId });

            return { url: session.customerPortalUrl };
        },

        getOrCreateCustomer: async (ref: CustomerRef): Promise<Customer> => {
            // Polar requires an email to mint a customer (pass it on first checkout via `CheckoutInput.email`);
            // `type: "individual"` selects the individual variant of Polar's customer-create union.
            const customer = await client.customers.create({
                email: ref.email ?? "",
                externalId: ref.referenceId,
                metadata: { ...ref.metadata, referenceId: ref.referenceId },
                type: "individual",
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
            // Polar's refund requires an explicit amount; for a full refund, read the order's total.
            const order = input.amount ? undefined : await client.orders.get({ id: input.sessionId });
            const currency = input.amount?.currency ?? order?.currency ?? "usd";
            const amountMinor = input.amount ? Number(input.amount.minorUnits) : (order?.totalAmount ?? 0);

            const refund = await client.refunds.create({
                amount: amountMinor,
                orderId: input.sessionId,
                // `reason` is an open enum; a caller-supplied string is cast onto it (defaults to customer_request).
                reason: (input.reason ?? "customer_request") as Parameters<typeof client.refunds.create>[0]["reason"],
            });

            const refundedAmount = input.amount ?? money(BigInt(Math.round(amountMinor)), currency);

            return {
                amount: refundedAmount,
                capturedAmount: refundedAmount,
                createdAt: Date.now(),
                id: input.sessionId,
                provider: "polar",
                referenceId: "",
                refundedAmount,
                // The same id Polar's confirming `refund.created` carries, which is what lets the sync
                // layer tell this refund's event from a concurrent refund of the identical amount.
                refundId: refund.id,
                state: "refunded",
                updatedAt: Date.now(),
            };
        },

        reportUsage: async (input: ReportUsageInput) => {
            // Polar event ingestion: one event per usage record, keyed to the customer by its
            // external id (the reference id we set on customer creation). Metadata carries the value.
            //
            // `externalId` is Polar's dedupe handle ("your unique identifier for this event"), so the
            // engine's idempotency key goes there: a reconcile sweep retrying a forward that already
            // landed must not meter the same usage twice — on a provider that owns entitlements, a
            // double-counted event bills the customer twice and eats their remaining allowance.
            await client.events.ingest({
                events: [
                    {
                        externalCustomerId: input.referenceId,
                        externalId: input.idempotencyKey,
                        metadata: { value: input.quantity },
                        name: input.featureId,
                        timestamp: input.timestamp === undefined ? undefined : new Date(input.timestamp),
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
