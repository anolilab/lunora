/**
 * Creem adapter.
 *
 * Creem (creem.io) is a **Merchant-of-Record** for software — like Polar and Dodo Payments, it is the
 * legal seller, and calculates/collects/remits tax across 190+ jurisdictions. It is **product-based**
 * (real product ids), so it slots into the `priceId`-centric {@link PaymentAdapter} directly: checkout
 * sessions return a hosted URL, subscriptions are first-class objects (cancel / pause / resume /
 * upgrade), and `customers.generateBillingLinks` gives a genuine hosted billing portal. Refunds are
 * handled from the Creem dashboard (no SDK endpoint), so `refundPayment` throws; manual authorize /
 * capture also throw (Creem owns the money movement).
 *
 * Takes an injected, structural `CreemClientLike` (so this package never imports the `creem` SDK);
 * pass `new Creem()` (with the api key threaded per call) from the app. Webhooks are verified with the
 * `creem-signature` HMAC-SHA256 scheme via {@link verifyCreemSignature}. Field casing varies across
 * the SDK's camelCase surface vs. raw webhook snake_case, so responses are read defensively.
 */
import type { PaymentAdapter, WebhookInput } from "../adapter";
import { LunoraPaymentError } from "../errors";
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
    Subscription,
    SubscriptionPatch,
    SubscriptionState,
    WebhookAction,
    WebhookActionType,
} from "../types";
import { verifyCreemSignature } from "../webhook";

/** The subset of the Creem SDK surface this adapter calls. A structural shim over `new Creem()` satisfies it. */
interface CreemClientLike {
    readonly checkouts: {
        readonly create: (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
        readonly retrieve: (checkoutId: string) => Promise<Record<string, unknown>>;
    };
    readonly customers: {
        readonly create: (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
        readonly generateBillingLinks: (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    readonly subscriptions: {
        readonly cancel: (subscriptionId: string) => Promise<Record<string, unknown>>;
        readonly get: (subscriptionId: string) => Promise<Record<string, unknown>>;
        readonly resume: (subscriptionId: string) => Promise<Record<string, unknown>>;
        readonly upgrade: (subscriptionId: string, request: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
}

interface CreemAdapterOptions {
    readonly client: CreemClientLike;
    readonly webhookSecret: string;
}

const PAYMENT_STATE_BY_CREEM_STATUS: Record<string, PaymentState> = {
    canceled: "canceled",
    completed: "captured",
    expired: "canceled",
    paid: "captured",
    partially_refunded: "partially_refunded",
    pending: "initiated",
    refunded: "refunded",
};

const SUBSCRIPTION_STATE_BY_CREEM_STATUS: Record<string, SubscriptionState> = {
    active: "active",
    canceled: "canceled",
    cancelled: "canceled",
    expired: "canceled",
    // SECURITY: `incomplete`/`unpaid`/`past_due` (first or a renewal payment not settled) must not map
    // to an entitling state — see the equivalent `incomplete` note in the Stripe/Polar adapters. A
    // `scheduled_cancel` subscription is still active until period end, so it entitles (the pending
    // cancellation surfaces via `cancelAtPeriodEnd`).
    incomplete: "past_due",
    paid: "active",
    past_due: "past_due",
    paused: "paused",
    scheduled_cancel: "active",
    trialing: "trialing",
    unpaid: "past_due",
};

const notSupported = (operation: string): never => {
    throw new LunoraPaymentError("PROVIDER_ERROR", `creem (merchant-of-record) does not support ${operation}`);
};

/** Creem `product`/`customer` fields are either an expanded object or a bare id string. */
const idOf = (value: unknown): string | undefined => (typeof value === "string" ? value : readString(asRecord(value), "id"));

/** Read the framework reference id, pinned into `metadata.referenceId` on checkout. */
const referenceFromMetadata = (object: Record<string, unknown>): string | undefined => readString(asRecord(object.metadata), "referenceId");

const readCheckoutUrl = (checkout: Record<string, unknown>): string => readString(checkout, "checkout_url") ?? readString(checkout, "checkoutUrl") ?? "";

const isCanceling = (subscription: Record<string, unknown>): boolean =>
    readString(subscription, "canceled_at") !== undefined ||
    readString(subscription, "canceledAt") !== undefined ||
    readString(subscription, "status") === "scheduled_cancel";

const subscriptionFromCreem = (subscription: Record<string, unknown>): Subscription => {
    const now = Date.now();
    const status = readString(subscription, "status") ?? "";

    return {
        cancelAtPeriodEnd: isCanceling(subscription),
        createdAt: now,
        currentPeriodEnd: parseTimestamp(readString(subscription, "current_period_end_date") ?? readString(subscription, "currentPeriodEndDate")),
        currentPeriodStart: parseTimestamp(readString(subscription, "current_period_start_date") ?? readString(subscription, "currentPeriodStartDate")),
        id: readString(subscription, "id") ?? "",
        priceId: idOf(subscription.product) ?? "",
        provider: "creem",
        quantity: readNumber(subscription, "units") ?? 1,
        referenceId: referenceFromMetadata(subscription) ?? idOf(subscription.customer) ?? "",
        // Fail closed: an unrecognized Creem status is treated as non-entitling `past_due`.
        state: SUBSCRIPTION_STATE_BY_CREEM_STATUS[status] ?? "past_due",
        updatedAt: now,
    };
};

/** A checkout/order carries the settled money — read it from the order when present, else the checkout. */
const checkoutToSession = (checkout: Record<string, unknown>): PaymentSession => {
    const now = Date.now();
    const order = asRecord(checkout.order);
    const currency = readString(order, "currency") ?? readString(checkout, "currency") ?? "usd";
    const amount = money(BigInt(readNumber(order, "amount") ?? readNumber(checkout, "amount") ?? 0), currency);
    const state = PAYMENT_STATE_BY_CREEM_STATUS[readString(order, "status") ?? readString(checkout, "status") ?? ""] ?? "initiated";
    const settled = state === "captured" || state === "partially_refunded" || state === "refunded";

    return {
        amount,
        capturedAmount: settled ? amount : zeroMoney(currency),
        createdAt: now,
        id: readString(checkout, "id") ?? "",
        provider: "creem",
        referenceId: referenceFromMetadata(checkout) ?? "",
        refundedAmount: state === "refunded" ? amount : zeroMoney(currency),
        state,
        updatedAt: now,
    };
};

const subscriptionEventType = (status: string | undefined): WebhookActionType => {
    const state = status ? SUBSCRIPTION_STATE_BY_CREEM_STATUS[status] : undefined;

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
    const base = { eventId, provider: "creem" as const, raw: { object, type: eventType } };
    const order = asRecord(object.order);
    const currency = readString(order, "currency") ?? readString(object, "currency") ?? "usd";

    switch (eventType) {
        case "checkout.completed": {
            const amount = readNumber(order, "amount") ?? readNumber(object, "amount");

            return {
                ...base,
                amount: amount === undefined ? undefined : money(BigInt(amount), currency),
                customerId: idOf(object.customer),
                referenceId: referenceFromMetadata(object),
                sessionId: readString(object, "id"),
                subscriptionId: idOf(object.subscription),
                type: "payment.captured",
            };
        }

        case "refund.created": {
            const amount = readNumber(object, "amount") ?? readNumber(order, "amount");

            return {
                ...base,
                amount: amount === undefined ? undefined : money(BigInt(amount), currency),
                referenceId: referenceFromMetadata(object),
                sessionId: idOf(object.order) ?? idOf(object.checkout) ?? readString(object, "id"),
                type: "payment.refunded",
            };
        }

        case "subscription.active":
        case "subscription.canceled":
        case "subscription.expired":
        case "subscription.paid":
        case "subscription.past_due":
        case "subscription.paused":
        case "subscription.scheduled_cancel":
        case "subscription.trialing":
        case "subscription.unpaid":
        case "subscription.update": {
            const status = eventType === "subscription.scheduled_cancel" ? "scheduled_cancel" : readString(object, "status");

            return {
                ...base,
                cancelAtPeriodEnd: readBoolean(object, "cancel_at_period_end") ?? isCanceling(object),
                currentPeriodEnd: parseTimestamp(readString(object, "current_period_end_date") ?? readString(object, "currentPeriodEndDate")),
                currentPeriodStart: parseTimestamp(readString(object, "current_period_start_date") ?? readString(object, "currentPeriodStartDate")),
                customerId: idOf(object.customer),
                priceId: idOf(object.product),
                referenceId: referenceFromMetadata(object) ?? idOf(object.customer),
                subscriptionId: readString(object, "id"),
                type: subscriptionEventType(status),
            };
        }

        default: {
            // dispute.created and any future event families — no state transition here.
            return { ...base, type: "unhandled" };
        }
    }
};

export const createCreemAdapter = (options: CreemAdapterOptions): PaymentAdapter => {
    const { client, webhookSecret } = options;

    return {
        // Creem is a Merchant-of-Record: it moves the money, so there is no manual payment-intent flow.
        cancelPayment: () => notSupported("manual payment cancellation"),

        cancelSubscription: async (subscriptionId) =>
            // Creem cancels at the end of the billing period (scheduled_cancel) and reports the real
            // resulting state — return that rather than assuming immediate cancellation.
            subscriptionFromCreem(await client.subscriptions.cancel(subscriptionId)),
        capabilities: { merchantOfRecord: true, portal: true, usageMetering: false },

        capturePayment: (_input: CaptureInput) => notSupported("manual capture"),

        createCheckout: async (input: CheckoutInput): Promise<CheckoutResult> => {
            const checkout = await client.checkouts.create({
                customer: input.customerId ? { id: input.customerId } : undefined,
                // Pin the framework-controlled `referenceId` LAST so caller metadata can never override it.
                metadata: { ...input.metadata, referenceId: input.referenceId },
                productId: input.priceId,
                requestId: input.idempotencyKey,
                successUrl: input.successUrl,
                units: input.quantity,
            });

            return { id: readString(checkout, "id") ?? "", provider: "creem", url: readCheckoutUrl(checkout) };
        },

        createPortalSession: async (input: PortalInput) => {
            const link = await client.customers.generateBillingLinks({ customerId: input.customerId });

            return { url: readString(link, "customer_portal_link") ?? readString(link, "customerPortalLink") ?? "" };
        },

        getOrCreateCustomer: async (ref: CustomerRef): Promise<Customer> => {
            const customer = await client.customers.create({ email: ref.email, name: ref.metadata?.name });

            return {
                createdAt: Date.now(),
                email: readString(customer, "email") ?? ref.email,
                id: readString(customer, "id") ?? "",
                provider: "creem",
                referenceId: ref.referenceId,
            };
        },

        getPaymentStatus: async (sessionId) => checkoutToSession(await client.checkouts.retrieve(sessionId)),

        getSubscriptionStatus: async (subscriptionId) => subscriptionFromCreem(await client.subscriptions.get(subscriptionId)),

        identifier: "creem",

        parseWebhook: async ({ headers, payload }: WebhookInput): Promise<WebhookAction> => {
            await verifyCreemSignature({ payload, secret: webhookSecret, signature: headers.get("creem-signature") ?? "" });

            const event = asRecord(JSON.parse(payload));

            return mapEvent(readString(event, "id") ?? "", readString(event, "eventType") ?? readString(event, "type") ?? "", asRecord(event.object));
        },

        // Creem refunds are issued from the dashboard; there is no SDK endpoint to initiate one.
        refundPayment: () => notSupported("programmatic refunds"),

        resumeSubscription: async (subscriptionId) => subscriptionFromCreem(await client.subscriptions.resume(subscriptionId)),

        updateSubscription: async (subscriptionId, patch: SubscriptionPatch) => {
            // A plan change is an `upgrade` to the new product (prorated immediately); a bare
            // metadata/quantity patch has no upgrade semantics, so return the current truth.
            if (patch.priceId) {
                return subscriptionFromCreem(
                    await client.subscriptions.upgrade(subscriptionId, { productId: patch.priceId, updateBehavior: "proration-charge-immediately" }),
                );
            }

            return subscriptionFromCreem(await client.subscriptions.get(subscriptionId));
        },
    };
};

export type { CreemAdapterOptions, CreemClientLike };
