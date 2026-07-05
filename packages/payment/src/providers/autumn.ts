/**
 * Autumn adapter.
 *
 * Autumn (useautumn.com) is an open-source pricing and billing layer that runs on **your own**
 * Stripe account — so, unlike Polar, it is **not** a merchant-of-record: you own the tax and the
 * invoice. Its model is entitlement-first (`attach` a product, then `check` / `track` features),
 * which maps onto Lunora's `createCheckout` + `check` / `track` + `reportUsage` surface.
 *
 * **Autumn owns entitlement truth.** Balances, credits, limits, and rollovers are computed on
 * Autumn's side from your plan config — so this adapter implements the optional
 * {@link PaymentAdapter.checkEntitlement} / {@link PaymentAdapter.getBalances} hooks, and the facade
 * delegates `check` / `listBalances` to Autumn's live API rather than the local ledger. The
 * authoritative sync path is therefore **live queries + `reconcile`**, not webhook fan-in: the
 * `autumn-js` SDK models no outbound webhook stream at all. Autumn's dashboard can still emit Svix
 * (Standard Webhooks) events, so {@link verifyStandardWebhook}-backed `parseWebhook` is provided as
 * a **best-effort** convenience — the exact event catalog is dashboard-configured and unverified
 * here, so `reconcile` (built on `getSubscriptionStatus`) remains the reliable path.
 *
 * Like the Polar adapter, this takes an injected, structural `AutumnClientLike` (so this package
 * never imports `autumn-js`); pass `new Autumn({ secretKey })` from the app. Autumn identifies a
 * subscription by the pair `(customer_id, product_id)` rather than a single id, so this adapter
 * encodes the Lunora `Subscription.id` as the composite `customerId::productId` and splits it
 * back apart for `cancel` / `getSubscriptionStatus` / `update` / `resume`. Autumn abstracts the
 * money movement through Stripe, so manual authorize/capture/cancel/refund of a payment intent has
 * no API surface and those throw. Field casing varies across autumn-js generations (classic
 * snake_case vs. the newer camelCase SDK), so responses are read defensively.
 */
import type { PaymentAdapter, WebhookInput } from "../adapter";
import { LunoraPaymentError } from "../errors";
import { asRecord, readBoolean, readNumber, readString } from "../json";
import { money } from "../money";
import type {
    CaptureInput,
    CheckInput,
    CheckoutInput,
    CheckoutResult,
    CheckResult,
    Customer,
    CustomerRef,
    FeatureBalance,
    PortalInput,
    ReportUsageInput,
    Subscription,
    SubscriptionPatch,
    SubscriptionState,
    WebhookAction,
} from "../types";
import { verifyStandardWebhook } from "../webhook";
import stateToEventType from "./subscription-event";

/** The subset of the Autumn SDK surface this adapter calls. A real `Autumn` instance satisfies it. */
interface AutumnClientLike {
    /** Attach a product to a customer — starts a checkout (hosted URL) or applies the change directly. */
    readonly attach: (parameters: Record<string, unknown>) => Promise<Record<string, unknown>>;
    /** Cancel a customer's product, immediately or at period end. */
    readonly cancel: (parameters: Record<string, unknown>) => Promise<Record<string, unknown>>;
    /** Ask Autumn whether a customer may use a feature / holds a product right now (its balance math). */
    readonly check: (parameters: Record<string, unknown>) => Promise<Record<string, unknown>>;
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

/**
 * Normalize one Autumn balance record into the numeric fields of a {@link CheckResult}. Reads across
 * SDK generations: `remaining`/`balance`, `granted`/`included_usage`/`limit`, `usage`/`used`. A
 * boolean feature (no numeric balance) leaves the numbers `undefined` and is `unlimited` when granted.
 */
const balanceFields = (balance: Record<string, unknown>): Pick<CheckResult, "balance" | "limit" | "unlimited" | "used"> => {
    return {
        balance: readAnyNumber(balance, "remaining", "balance"),
        limit: readAnyNumber(balance, "granted", "included_usage", "limit"),
        unlimited: readBoolean(balance, "unlimited") ?? false,
        used: readAnyNumber(balance, "usage", "used"),
    };
};

/** Deterministically construct the subscription for the fail-closed "no such product" case. */
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

/**
 * Read Autumn's authoritative subscription for a `(customerId, productId)` pair from the customer's
 * product list. A missing product means the reference holds no grant on it — fail closed as canceled.
 * Cancel / update / resume re-read through this (rather than fabricating a state/quantity) so the
 * store is never desynced and a non-entitling status is never silently promoted to `active`.
 */
const readSubscription = async (client: AutumnClientLike, customerId: string, productId: string): Promise<Subscription> => {
    const customer = await client.customers.get(customerId);
    const product = findProduct(customer, productId);

    return product ? productToSubscription(customerId, product) : constructedSubscription(customerId, productId, "canceled", false);
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
                type: stateToEventType(SUBSCRIPTION_STATE_BY_AUTUMN_STATUS[status ?? ""]),
            };
        }
        // Money movement — Autumn surfaces settled invoices/payments.
        case "invoice.paid":
        case "payment.succeeded": {
            const amount = readAnyNumber(object, "total", "amount", "amount_paid");

            return {
                ...base,
                // Autumn amounts are assumed integer minor units, but the event catalog is unverified —
                // round defensively so a provider-sent decimal can't throw a RangeError out of
                // `parseWebhook` (which would 400 the endpoint and wedge Autumn into infinite retries).
                amount: amount === undefined ? undefined : money(BigInt(Math.round(amount)), currency),
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

            // An immediate cancel is terminal — canceled, unambiguously. A cancel-at-period-end leaves
            // the product active-until-end, so re-read Autumn's real status and only flip the schedule
            // flag: never assume `active` (a `past_due`/`paused` grant must not be re-entitled here).
            if (cancelOptions?.atPeriodEnd) {
                return { ...(await readSubscription(client, customerId, productId)), cancelAtPeriodEnd: true };
            }

            return constructedSubscription(customerId, productId, "canceled", false);
        },

        capabilities: { merchantOfRecord: false, portal: true, usageMetering: true },

        capturePayment: (_input: CaptureInput) => notSupported("manual capture"),

        checkEntitlement: async (input: CheckInput): Promise<CheckResult> => {
            // Autumn owns the balance math — ask it directly. `required_balance` is how many units the
            // caller intends to consume; default it to 1 to match the local evaluator's semantics (an
            // omitted quantity means "is at least one unit available?"), never fail open on undefined.
            // `feature_id` gates a feature, `product_id` gates product access.
            const result = await client.check({
                customer_id: input.referenceId,
                feature_id: input.featureId,
                product_id: input.priceId,
                required_balance: input.quantity ?? 1,
            });
            const allowed = readBoolean(result, "allowed") ?? false;

            // A product check has no numeric balance — return the bare allow/deny.
            if (input.featureId === undefined) {
                return { allowed, unlimited: false };
            }

            // The feature balance may be a nested object (newer SDK: `balance: { remaining, granted, … }`)
            // or inlined on the response as a top-level number (`balance: 100` + `included_usage`/`usage`).
            // Only descend into `balance` when it is an object; otherwise read the fields off the response
            // itself — so a numeric top-level `balance` is not lost to `asRecord(number) === {}`.
            const rawBalance = result.balance;
            const balance = typeof rawBalance === "object" && rawBalance !== null ? asRecord(rawBalance) : result;

            return { allowed, ...balanceFields(balance) };
        },

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

        getBalances: async (referenceId): Promise<FeatureBalance[]> => {
            // Autumn returns every feature balance on the customer, keyed by feature id. Newer SDKs put
            // it under `balances`; classic ones under `features`.
            const customer = await client.customers.get(referenceId);
            const balances = asRecord(customer.balances ?? customer.features);

            return Object.entries(balances).map(([key, raw]) => {
                const balance = asRecord(raw);
                const fields = balanceFields(balance);
                // `allowed` mirrors the local evaluator: unlimited, or some balance remains.
                const allowed = fields.unlimited || (fields.balance ?? 0) > 0;

                return { allowed, featureId: readAny(balance, "featureId", "feature_id") ?? key, ...fields };
            });
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

            return readSubscription(client, customerId, productId);
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

            // Re-attaching the product undoes a scheduled cancellation; re-read the real state rather
            // than assuming `active`, and clear the schedule flag.
            await client.attach({ customer_id: customerId, product_id: productId });

            return { ...(await readSubscription(client, customerId, productId)), cancelAtPeriodEnd: false };
        },

        updateSubscription: async (subscriptionId, patch: SubscriptionPatch) => {
            const { customerId, productId } = parseAutumnSubscriptionId(subscriptionId);
            const targetProduct = patch.priceId ?? productId;

            // A plan change is an `attach` of the new product. Autumn keys prepaid quantity by feature,
            // so a bare `quantity` patch has no direct attach mapping; re-read Autumn's authoritative
            // subscription (its real state AND quantity) instead of fabricating `quantity: 1` / `active`.
            await client.attach({ customer_id: customerId, product_id: targetProduct });

            return readSubscription(client, customerId, targetProduct);
        },
    };
};

export type { AutumnAdapterOptions, AutumnClientLike };
