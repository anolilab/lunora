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
 * The public `client` is the small structural {@link AutumnClientLike} (a real `autumn-js` `Autumn`
 * instance satisfies it, no cast); internally it is used as the real `Autumn` so calls are checked
 * against the SDK. The SDK is resource-based (`billing.attach` / `billing.update` with a
 * `cancelAction` / `billing.openCustomerPortal`, `customers.getOrCreate` / `customers.get`, top-level
 * `check` / `track`). Autumn identifies a subscription by the pair `(customerId, planId)`, so this
 * adapter encodes the Lunora `Subscription.id` as the composite `customerId::planId`. Autumn abstracts
 * money movement through Stripe, so manual authorize/capture/refund throw. Responses are read
 * defensively (fields vary across `autumn-js` generations).
 */
import type { Autumn } from "autumn-js";

import type { PaymentAdapter, WebhookInput } from "../adapter";
import { LunoraPaymentError } from "../errors";
import { asRecord, readAny, readAnyNumber, readBoolean, readString } from "../json";
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
import makeNotSupported from "./not-supported";
import stateToEventType from "./subscription-event";

/**
 * The `autumn-js` SDK surface the adapter uses, as a structural type — a real `Autumn` instance
 * satisfies it without a cast. Resources/methods are `unknown` (the adapter re-types the client as
 * the real `Autumn` internally); this keeps the SDK's full type out of the published declarations.
 * @experimental
 */
interface AutumnClientLike {
    readonly billing: unknown;
    readonly check: unknown;
    readonly customers: unknown;
    readonly track: unknown;
}

/**
 * `AutumnAdapterOptions` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
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

/** `billing.updated` reports each plan change via an `action`; map it to a state when no `status` is present. */
const SUBSCRIPTION_STATE_BY_AUTUMN_ACTION: Record<string, SubscriptionState> = {
    activated: "active",
    canceled: "canceled",
    cancelled: "canceled",
    expired: "canceled",
    scheduled: "paused",
};

const SUBSCRIPTION_ID_SEPARATOR = "::";

const notSupported = makeNotSupported("autumn");

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

/** Autumn expresses a scheduled cancellation via a non-null `canceled_at`. */
const isCanceling = (product: Record<string, unknown>): boolean =>
    readAnyNumber(product, "canceled_at", "canceledAt") !== undefined || readAny(product, "status") === "scheduled";

const productToSubscription = (customerId: string, product: Record<string, unknown>): Subscription => {
    const now = Date.now();
    // Newer Autumn generations key the plan as `plan_id` under a `subscriptions` row; classic ones use
    // `id`/`product_id` under `products`. Read across both so an active subscriber is never missed.
    const productId = readAny(product, "id", "product_id", "productId", "plan_id", "planId") ?? "";
    const status = readAny(product, "status") ?? "active";
    // Current Autumn exposes past-due as a separate boolean rather than a status — honor it so an
    // otherwise-`active` row that is past due is treated as non-entitling (fail closed), never entitling.
    const pastDue = readBoolean(product, "past_due") ?? readBoolean(product, "pastDue") ?? false;

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
        // Fail closed: a past-due flag, or an unrecognized Autumn status, is non-entitling `past_due`.
        state: pastDue ? "past_due" : (SUBSCRIPTION_STATE_BY_AUTUMN_STATUS[status] ?? "past_due"),
        updatedAt: now,
    };
};

/**
 * Find a customer's plan row by product/plan id. Scans both the classic `products` array and the
 * newer `subscriptions` array, matching on any of the id field names those generations use.
 */
const asRecordList = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.map((entry) => asRecord(entry)) : []);

const findProduct = (customer: Record<string, unknown>, productId: string): Record<string, unknown> | undefined => {
    const rows = [...asRecordList(customer.products), ...asRecordList(customer.subscriptions)];

    return rows.find((entry) => (readAny(entry, "id", "product_id", "productId", "plan_id", "planId") ?? "") === productId);
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
const readSubscription = async (client: Autumn, customerId: string, productId: string): Promise<Subscription> => {
    const customer = asRecord(await client.customers.get({ customerId }));
    const product = findProduct(customer, productId);

    return product ? productToSubscription(customerId, product) : constructedSubscription(customerId, productId, "canceled", false);
};

// Webhook bodies carry the event `type` and a `data` object. Read the reference id (the Autumn
// customer id, which is our reference id) and the product/subscription details defensively.
const referenceFromEvent = (object: Record<string, unknown>): string | undefined => readAny(object, "customer_id", "customerId");

/**
 * Autumn's primary subscription-lifecycle event. `data` carries `customer_id` and a `plan_changes[]`
 * array of `{ action, subscription: { plan_id, status, past_due, … } }`; older shapes inline the row.
 * Read across both — reconcile stays authoritative (see the header note).
 */
const mapBillingUpdated = (eventId: string, object: Record<string, unknown>): WebhookAction => {
    const base = { eventId, provider: "autumn" as const, raw: { object, type: "billing.updated" } };
    const customerId = referenceFromEvent(object);
    const change = asRecordList(object.plan_changes)[0] ?? object;
    const subscription = change.subscription ? asRecord(change.subscription) : change;
    const planId = readAny(subscription, "plan_id", "planId", "product_id", "productId", "id");
    const status = readAny(subscription, "status");
    const action = readAny(change, "action");
    const pastDue = readBoolean(subscription, "past_due") ?? readBoolean(subscription, "pastDue") ?? false;
    const fromStatus = status === undefined ? undefined : SUBSCRIPTION_STATE_BY_AUTUMN_STATUS[status];
    const fromAction = action === undefined ? undefined : SUBSCRIPTION_STATE_BY_AUTUMN_ACTION[action];
    const state: SubscriptionState | undefined = pastDue ? "past_due" : (fromStatus ?? fromAction);

    return {
        ...base,
        cancelAtPeriodEnd: readBoolean(subscription, "cancel_at_period_end") ?? isCanceling(subscription),
        currentPeriodEnd: readAnyNumber(subscription, "current_period_end", "currentPeriodEnd"),
        currentPeriodStart: readAnyNumber(subscription, "current_period_start", "currentPeriodStart"),
        customerId,
        priceId: planId,
        referenceId: customerId,
        subscriptionId: customerId === undefined || planId === undefined ? undefined : autumnSubscriptionId(customerId, planId),
        type: stateToEventType(state),
    };
};

const mapEvent = (eventId: string, eventType: string, object: Record<string, unknown>): WebhookAction => {
    const base = { eventId, provider: "autumn" as const, raw: { object, type: eventType } };
    const currency = readAny(object, "currency") ?? "usd";

    switch (eventType) {
        // Auto-topup settles a real invoice — surface it as a captured payment.
        case "billing.auto_topup_succeeded": {
            const invoice = asRecord(object.invoice);
            const amount = readAnyNumber(invoice, "total", "amount") ?? readAnyNumber(object, "total", "amount");
            const invoiceCurrency = readAny(invoice, "currency") ?? currency;

            return {
                ...base,
                amount: amount === undefined ? undefined : money(BigInt(Math.round(amount)), invoiceCurrency),
                customerId: referenceFromEvent(object),
                referenceId: referenceFromEvent(object),
                sessionId: readAny(invoice, "id", "stripe_id", "invoice_id") ?? readAny(object, "id"),
                type: "payment.captured",
            };
        }

        case "billing.updated": {
            return mapBillingUpdated(eventId, object);
        }

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

/**
 * `createAutumnAdapter` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export const createAutumnAdapter = (options: AutumnAdapterOptions): PaymentAdapter => {
    const { webhookSecret } = options;
    // Use the injected client as the real `Autumn` internally so every call is checked against the SDK.
    const client = options.client as unknown as Autumn;

    return {
        // Autumn abstracts Stripe money movement; there is no payment intent to cancel/capture/refund.
        cancelPayment: () => notSupported("manual payment cancellation"),

        cancelSubscription: async (subscriptionId, cancelOptions) => {
            const { customerId, productId } = parseAutumnSubscriptionId(subscriptionId);

            // Autumn cancels via `billing.update` with a `cancelAction`; `cancel_end_of_cycle` schedules
            // the cancellation, `cancel_immediately` ends it now (with a prorated refund).
            await client.billing.update({
                cancelAction: cancelOptions?.atPeriodEnd ? "cancel_end_of_cycle" : "cancel_immediately",
                customerId,
                planId: productId,
            });

            // A cancel-at-period-end leaves the product active-until-end, so re-read Autumn's real status
            // and only flip the schedule flag: never assume `active` (a `past_due`/`paused` grant must
            // not be re-entitled here). An immediate cancel is terminal.
            if (cancelOptions?.atPeriodEnd) {
                return { ...(await readSubscription(client, customerId, productId)), cancelAtPeriodEnd: true };
            }

            return constructedSubscription(customerId, productId, "canceled", false);
        },

        capabilities: { merchantOfRecord: false, portal: true, usageMetering: true },

        capturePayment: (_input: CaptureInput) => notSupported("manual capture"),

        checkEntitlement: async (input: CheckInput): Promise<CheckResult> => {
            // Autumn's `check` is feature-scoped (no product-id param). For a product-access check
            // (priceId, no featureId), read the customer's plans and test whether the product is
            // present and entitling — fail closed otherwise.
            if (input.featureId === undefined) {
                const customer = asRecord(await client.customers.get({ customerId: input.referenceId }));
                const product = findProduct(customer, input.priceId ?? "");
                const state = product ? productToSubscription(input.referenceId, product).state : undefined;

                return { allowed: state === "active" || state === "trialing", unlimited: false };
            }

            // Feature check — Autumn owns the balance math. `requiredBalance` is how many units the caller
            // intends to consume; default it to 1 (an omitted quantity means "is at least one available?").
            const result = asRecord(await client.check({ customerId: input.referenceId, featureId: input.featureId, requiredBalance: input.quantity ?? 1 }));
            const allowed = readBoolean(result, "allowed") ?? false;

            // The feature balance may be a nested object (`balance: { remaining, granted, … }`) or inlined
            // as a top-level number (`balance: 100` + `includedUsage`/`usage`). Only descend into `balance`
            // when it is an object; otherwise read the fields off the response itself.
            const rawBalance = result.balance;
            const balance = typeof rawBalance === "object" && rawBalance !== null ? asRecord(rawBalance) : result;

            return { allowed, ...balanceFields(balance) };
        },

        createCheckout: async (input: CheckoutInput): Promise<CheckoutResult> => {
            // Autumn keys everything on the customer id (our reference id), so there is no metadata to pin;
            // `attach` returns a hosted `paymentUrl` when a payment step is needed.
            const result = asRecord(await client.billing.attach({ customerId: input.referenceId, planId: input.priceId }));

            return { id: autumnSubscriptionId(input.referenceId, input.priceId), provider: "autumn", url: checkoutUrlFrom(result) };
        },

        createPortalSession: async (input: PortalInput) => {
            // Autumn's portal is a top-level billing method (no return URL — that is configured in Autumn).
            const result = asRecord(await client.billing.openCustomerPortal({ customerId: input.customerId }));

            return { url: readAny(result, "url") ?? "" };
        },

        getBalances: async (referenceId): Promise<FeatureBalance[]> => {
            // Autumn returns every feature balance on the customer, keyed by feature id. Newer SDKs put
            // it under `balances`; classic ones under `features`.
            const customer = asRecord(await client.customers.get({ customerId: referenceId }));
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
            // Autumn's `getOrCreate` is idempotent — the app-supplied `customerId` (our reference id) IS the id.
            const customer = asRecord(await client.customers.getOrCreate({ customerId: ref.referenceId, email: ref.email, name: ref.metadata?.name }));

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
            // Autumn delivers through Svix, whose canonical headers are `svix-id` / `svix-timestamp` /
            // `svix-signature`. Accept those first (falling back to the bare `webhook-*` aliases some
            // Standard-Webhooks gateways forward) so a genuine Autumn delivery verifies instead of 400ing.
            const webhookId = headers.get("svix-id") ?? headers.get("webhook-id") ?? "";

            await verifyStandardWebhook({
                payload,
                secret: webhookSecret,
                toleranceSeconds: options.webhookToleranceSeconds,
                webhookId,
                webhookSignature: headers.get("svix-signature") ?? headers.get("webhook-signature") ?? "",
                webhookTimestamp: headers.get("svix-timestamp") ?? headers.get("webhook-timestamp") ?? "",
            });

            const event = asRecord(JSON.parse(payload));

            // Standard Webhooks carries no body id, so the delivery id header is our idempotency key.
            return mapEvent(webhookId, readString(event, "type") ?? "", asRecord(event.data));
        },

        refundPayment: () => notSupported("refunds"),

        reportUsage: async (input: ReportUsageInput) => {
            // Autumn `track`: record `value` units of `featureId` for the customer. Note the SDK exposes
            // no request-body idempotency key, so exactly-once is enforced by the local ledger (the
            // facade dedupes on the caller key before forwarding here).
            await client.track({ customerId: input.referenceId, featureId: input.featureId, value: input.quantity });
        },

        resumeSubscription: async (subscriptionId) => {
            const { customerId, productId } = parseAutumnSubscriptionId(subscriptionId);

            // `uncancel` reverses a pending scheduled cancellation; re-read the real state rather than
            // assuming `active`, and clear the schedule flag.
            await client.billing.update({ cancelAction: "uncancel", customerId, planId: productId });

            return { ...(await readSubscription(client, customerId, productId)), cancelAtPeriodEnd: false };
        },

        updateSubscription: async (subscriptionId, patch: SubscriptionPatch) => {
            const { customerId, productId } = parseAutumnSubscriptionId(subscriptionId);
            const targetProduct = patch.priceId ?? productId;

            // A plan change is an `attach` of the new product. Autumn keys prepaid quantity by feature,
            // so a bare `quantity` patch has no direct attach mapping; re-read Autumn's authoritative
            // subscription (its real state AND quantity) instead of fabricating `quantity: 1` / `active`.
            await client.billing.attach({ customerId, planId: targetProduct });

            return readSubscription(client, customerId, targetProduct);
        },
    };
};

export type { AutumnAdapterOptions, AutumnClientLike };
