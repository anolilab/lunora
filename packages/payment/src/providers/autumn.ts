/**
 * Autumn adapter.
 *
 * Autumn (useautumn.com) is an open-source pricing and billing layer that runs on **your own**
 * Stripe account — so, unlike Polar, it is **not** a merchant-of-record: you own the tax and the
 * invoice. Its model is entitlement-first (`attach` a product, then `check` / `track` features),
 * which maps onto Lunora's `createCheckout` + `reportUsage` surface.
 *
 * Like the Polar adapter, this takes an injected, structural `AutumnClientLike` (so this package
 * never imports `autumn-js`); pass `new Autumn({ secretKey })` from the app. Autumn identifies a
 * subscription by the pair `(customer_id, product_id)` rather than a single id, so this adapter
 * encodes the Lunora `Subscription.id` as the composite `customerId::productId` and splits it
 * back apart for `cancel` / `getSubscriptionStatus` / `update` / `resume`. Autumn abstracts the
 * money movement through Stripe, so manual authorize/capture/cancel/refund of a payment intent has
 * no API surface and those throw. Webhooks use the Standard Webhooks (Svix) scheme, verified by
 * {@link verifyStandardWebhook} — the same as Polar. Field casing varies across autumn-js
 * generations (classic snake_case vs. the newer camelCase SDK), so responses are read defensively.
 */
import type { PaymentAdapter, WebhookInput } from "../adapter";
import { LunoraPaymentError } from "../errors";
import { asRecord, readBoolean, readNumber, readString } from "../json";
import { money } from "../money";
import type {
    CaptureInput,
    CheckoutInput,
    CheckoutResult,
    Customer,
    CustomerRef,
    PortalInput,
    ReportUsageInput,
    Subscription,
    SubscriptionPatch,
    SubscriptionState,
    WebhookAction,
    WebhookActionType,
} from "../types";
import { verifyStandardWebhook } from "../webhook";

/** The subset of the Autumn SDK surface this adapter calls. A real `Autumn` instance satisfies it. */
interface AutumnClientLike {
    /** Attach a product to a customer — starts a checkout (hosted URL) or applies the change directly. */
    readonly attach: (parameters: Record<string, unknown>) => Promise<Record<string, unknown>>;
    /** Cancel a customer's product, immediately or at period end. */
    readonly cancel: (parameters: Record<string, unknown>) => Promise<Record<string, unknown>>;
    readonly customers: {
        readonly billingPortal: (customerId: string, parameters?: Record<string, unknown>) => Promise<Record<string, unknown>>;
        readonly create: (parameters: Record<string, unknown>) => Promise<Record<string, unknown>>;
        readonly get: (customerId: string, parameters?: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    /** Record metered usage for a customer's feature. */
    readonly track: (parameters: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

interface AutumnAdapterOptions {
    readonly client: AutumnClientLike;
    readonly webhookSecret: string;
    readonly webhookToleranceSeconds?: number;
}

/**
 * Autumn statuses that confer an entitling subscription state are mapped explicitly. Everything
 * else — including `scheduled` (a product queued for a *future* period) — maps to a non-entitling
 * state so a not-yet-active plan never grants access early (see the equivalent `incomplete` note in
 * the Stripe/Polar adapters). Reserve `trialing` for a genuine Autumn trial.
 */
const SUBSCRIPTION_STATE_BY_AUTUMN_STATUS: Record<string, SubscriptionState> = {
    active: "active",
    canceled: "canceled",
    expired: "canceled",
    past_due: "past_due",
    // A scheduled product has not started yet — non-entitling until it activates.
    scheduled: "paused",
    trialing: "trialing",
};

const SUBSCRIPTION_ID_SEPARATOR = "::";

const notSupported = (operation: string): never => {
    throw new LunoraPaymentError("PROVIDER_ERROR", `autumn manages billing through the underlying processor and does not support ${operation}`);
};

/** Encode the Lunora subscription id from Autumn's `(customerId, productId)` pair. */
const autumnSubscriptionId = (customerId: string, productId: string): string => `${customerId}${SUBSCRIPTION_ID_SEPARATOR}${productId}`;

/**
 * Split a composite id back into `(customerId, productId)`. The `productId` is an Autumn product
 * slug (no separator), so split on the LAST separator — a `referenceId` that itself contains `::`
 * is preserved intact as the customer id.
 */
const parseAutumnSubscriptionId = (subscriptionId: string): { customerId: string; productId: string } => {
    const index = subscriptionId.lastIndexOf(SUBSCRIPTION_ID_SEPARATOR);

    if (index === -1) {
        throw new LunoraPaymentError("PROVIDER_ERROR", `malformed autumn subscription id "${subscriptionId}" (expected "<customerId>::<productId>")`);
    }

    return { customerId: subscriptionId.slice(0, index), productId: subscriptionId.slice(index + SUBSCRIPTION_ID_SEPARATOR.length) };
};

/** First defined string among the given keys — tolerates snake_case vs. camelCase SDK generations. */
const readAny = (object: Record<string, unknown>, ...keys: string[]): string | undefined => {
    for (const key of keys) {
        const value = readString(object, key);

        if (value !== undefined) {
            return value;
        }
    }

    return undefined;
};

/** First defined number among the given keys. */
const readAnyNumber = (object: Record<string, unknown>, ...keys: string[]): number | undefined => {
    for (const key of keys) {
        const value = readNumber(object, key);

        if (value !== undefined) {
            return value;
        }
    }

    return undefined;
};

/** Autumn expresses a scheduled cancellation via a non-null `canceled_at`. */
const isCanceling = (product: Record<string, unknown>): boolean =>
    readAnyNumber(product, "canceled_at", "canceledAt") !== undefined || readAny(product, "status") === "scheduled";

const productToSubscription = (customerId: string, product: Record<string, unknown>): Subscription => {
    const now = Date.now();
    const productId = readAny(product, "id", "product_id", "productId") ?? "";
    const status = readAny(product, "status") ?? "active";

    return {
        cancelAtPeriodEnd: isCanceling(product),
        createdAt: now,
        currentPeriodEnd: readAnyNumber(product, "current_period_end", "currentPeriodEnd") ?? undefined,
        currentPeriodStart: readAnyNumber(product, "current_period_start", "currentPeriodStart") ?? undefined,
        id: autumnSubscriptionId(customerId, productId),
        priceId: productId,
        provider: "autumn",
        quantity: readAnyNumber(product, "quantity") ?? 1,
        referenceId: customerId,
        // Fail closed: an unrecognized Autumn status is treated as non-entitling `past_due`.
        state: SUBSCRIPTION_STATE_BY_AUTUMN_STATUS[status] ?? "past_due",
        updatedAt: now,
    };
};

/** Find a customer's product row by product id across the (possibly variously-named) list. */
const findProduct = (customer: Record<string, unknown>, productId: string): Record<string, unknown> | undefined => {
    const products = Array.isArray(customer.products) ? customer.products : [];

    return products.map((entry) => asRecord(entry)).find((entry) => (readAny(entry, "id", "product_id", "productId") ?? "") === productId);
};

/** Deterministically construct the subscription a cancel/update/resume call resolves to. */
const constructedSubscription = (customerId: string, productId: string, state: SubscriptionState, cancelAtPeriodEnd: boolean): Subscription => {
    const now = Date.now();

    return {
        cancelAtPeriodEnd,
        createdAt: now,
        id: autumnSubscriptionId(customerId, productId),
        priceId: productId,
        provider: "autumn",
        quantity: 1,
        referenceId: customerId,
        state,
        updatedAt: now,
    };
};

const subscriptionEventType = (status: string | undefined): WebhookActionType => {
    const state = status ? SUBSCRIPTION_STATE_BY_AUTUMN_STATUS[status] : undefined;

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

// Webhook bodies carry the event `type` and a `data` object. Read the reference id (the Autumn
// customer id, which is our reference id) and the product/subscription details defensively.
const referenceFromEvent = (object: Record<string, unknown>): string | undefined => readAny(object, "customer_id", "customerId");

const mapEvent = (eventId: string, eventType: string, object: Record<string, unknown>): WebhookAction => {
    const base = { eventId, provider: "autumn" as const, raw: { object, type: eventType } };
    const currency = readAny(object, "currency") ?? "usd";

    switch (eventType) {
        // Product lifecycle — the entitling truth. `data` is the product row (or wraps it).
        case "customer.product.added":
        case "customer.product.canceled":
        case "customer.product.expired":
        case "customer.product.updated":
        case "product.attached": {
            const product = object.product ? asRecord(object.product) : object;
            const status = eventType === "customer.product.canceled" || eventType === "customer.product.expired" ? "canceled" : readAny(product, "status");
            const customerId = referenceFromEvent(object) ?? referenceFromEvent(product);

            return {
                ...base,
                cancelAtPeriodEnd: readBoolean(product, "cancel_at_period_end") ?? isCanceling(product),
                currentPeriodEnd: readAnyNumber(product, "current_period_end", "currentPeriodEnd"),
                currentPeriodStart: readAnyNumber(product, "current_period_start", "currentPeriodStart"),
                customerId,
                priceId: readAny(product, "id", "product_id", "productId"),
                referenceId: customerId,
                subscriptionId:
                    customerId === undefined ? undefined : autumnSubscriptionId(customerId, readAny(product, "id", "product_id", "productId") ?? ""),
                type: subscriptionEventType(status),
            };
        }
        // Money movement — Autumn surfaces settled invoices/payments.
        case "invoice.paid":
        case "payment.succeeded": {
            const amount = readAnyNumber(object, "total", "amount", "amount_paid");

            return {
                ...base,
                amount: amount === undefined ? undefined : money(BigInt(amount), currency),
                customerId: referenceFromEvent(object),
                referenceId: referenceFromEvent(object),
                sessionId: readAny(object, "id", "invoice_id", "stripe_id"),
                type: "payment.captured",
            };
        }

        default: {
            return { ...base, type: "unhandled" };
        }
    }
};

/** Read a hosted checkout / payment URL from an `attach` response across SDK generations. */
const checkoutUrlFrom = (result: Record<string, unknown>): string => readAny(result, "checkout_url", "checkoutUrl", "payment_url", "paymentUrl", "url") ?? "";

export const createAutumnAdapter = (options: AutumnAdapterOptions): PaymentAdapter => {
    const { client, webhookSecret } = options;

    return {
        // Autumn abstracts Stripe money movement; there is no payment intent to cancel/capture/refund.
        cancelPayment: () => notSupported("manual payment cancellation"),

        cancelSubscription: async (subscriptionId, cancelOptions) => {
            const { customerId, productId } = parseAutumnSubscriptionId(subscriptionId);

            await client.cancel({ cancel_immediately: cancelOptions?.atPeriodEnd !== true, customer_id: customerId, product_id: productId });

            return cancelOptions?.atPeriodEnd
                ? constructedSubscription(customerId, productId, "active", true)
                : constructedSubscription(customerId, productId, "canceled", false);
        },

        capabilities: { merchantOfRecord: false, portal: true, usageMetering: true },

        capturePayment: (_input: CaptureInput) => notSupported("manual capture"),

        createCheckout: async (input: CheckoutInput): Promise<CheckoutResult> => {
            const result = await client.attach({
                customer_id: input.referenceId,
                // Pin the framework-controlled `referenceId` LAST so caller metadata can never override it.
                metadata: { ...input.metadata, referenceId: input.referenceId },
                product_id: input.priceId,
                success_url: input.successUrl,
            });

            return { id: autumnSubscriptionId(input.referenceId, input.priceId), provider: "autumn", url: checkoutUrlFrom(result) };
        },

        createPortalSession: async (input: PortalInput) => {
            const result = await client.customers.billingPortal(input.customerId, { return_url: input.returnUrl });
            const data = asRecord(result.data);

            return { url: readAny(result, "url") ?? readAny(data, "url") ?? "" };
        },

        getOrCreateCustomer: async (ref: CustomerRef): Promise<Customer> => {
            // Autumn's create is idempotent — the app-supplied `id` (our reference id) IS the customer id.
            const customer = await client.customers.create({ email: ref.email, id: ref.referenceId, name: ref.metadata?.name });

            return {
                createdAt: Date.now(),
                email: readAny(customer, "email") ?? ref.email,
                id: readAny(customer, "id") ?? ref.referenceId,
                provider: "autumn",
                referenceId: ref.referenceId,
            };
        },

        // Autumn is entitlement-centric; it exposes no standalone one-time payment-session lookup.
        getPaymentStatus: () => notSupported("payment-session reconciliation"),

        getSubscriptionStatus: async (subscriptionId) => {
            const { customerId, productId } = parseAutumnSubscriptionId(subscriptionId);
            const customer = await client.customers.get(customerId);
            const product = findProduct(customer, productId);

            // No matching product means the reference holds no grant on it — fail closed as canceled.
            return product ? productToSubscription(customerId, product) : constructedSubscription(customerId, productId, "canceled", false);
        },

        identifier: "autumn",

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

        refundPayment: () => notSupported("refunds"),

        reportUsage: async (input: ReportUsageInput) => {
            // Autumn `track`: record `value` units of `feature_id` for the customer, deduped by the key.
            await client.track({
                customer_id: input.referenceId,
                feature_id: input.featureId,
                idempotency_key: input.idempotencyKey,
                value: input.quantity,
            });
        },

        resumeSubscription: async (subscriptionId) => {
            const { customerId, productId } = parseAutumnSubscriptionId(subscriptionId);

            // Re-attaching the product undoes a scheduled cancellation.
            await client.attach({ customer_id: customerId, product_id: productId });

            return constructedSubscription(customerId, productId, "active", false);
        },

        updateSubscription: async (subscriptionId, patch: SubscriptionPatch) => {
            const { customerId, productId } = parseAutumnSubscriptionId(subscriptionId);
            const targetProduct = patch.priceId ?? productId;

            // A plan change is an `attach` of the new product; a bare quantity change re-attaches the same one.
            await client.attach({ customer_id: customerId, product_id: targetProduct });

            return constructedSubscription(customerId, targetProduct, "active", false);
        },
    };
};

export type { AutumnAdapterOptions, AutumnClientLike };
