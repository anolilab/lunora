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
import type { Creem } from "creem";

import type { PaymentAdapter, WebhookInput } from "../adapter";
import { asRecord, parseTimestamp, readAny, readAnyNumber, readBoolean, readNumber, readString, referenceFromMetadata } from "../json";
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
} from "../types";
import { verifyCreemSignature } from "../webhook";
import makeNotSupported from "./not-supported";
import stateToEventType from "./subscription-event";

/** The "already exists" message text Creem's API is documented to return for a duplicate-email conflict. */
const ALREADY_EXISTS_PATTERN = /already exists/iu;

/**
 * The `creem` SDK surface the adapter uses, as a structural type — a real `Creem` instance satisfies
 * it without a cast. Resources are `unknown` (the adapter re-types the client as the real `Creem`
 * internally); this keeps the SDK's full type out of the published declarations.
 * @experimental
 */
interface CreemClientLike {
    readonly checkouts: unknown;
    readonly customers: unknown;
    readonly subscriptions: unknown;
}

/**
 * `CreemAdapterOptions` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
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

const notSupported = makeNotSupported("creem (merchant-of-record)");

/** Creem `product`/`customer` fields are either an expanded object or a bare id string. */
const idOf = (value: unknown): string | undefined => (typeof value === "string" ? value : readString(asRecord(value), "id"));

const readCheckoutUrl = (checkout: Record<string, unknown>): string => readAny(checkout, "checkout_url", "checkoutUrl") ?? "";

const isCanceling = (subscription: Record<string, unknown>): boolean =>
    readAny(subscription, "canceled_at", "canceledAt") !== undefined || readString(subscription, "status") === "scheduled_cancel";

/**
 * Whether a `customers.create` rejection is Creem's known duplicate-email conflict (safe to recover
 * from via an email lookup) as opposed to a network/quota/auth failure (which must propagate). The
 * real SDK's `CreemError` carries a `statusCode`, but `CreemClientLike` is a structural, injected type
 * with no guaranteed error shape — so a present `statusCode` outside Creem's documented 400/409
 * conflict range is trusted to rule the error out, and otherwise this falls back to matching the
 * "already exists" message text Creem's API is documented to return for the conflict.
 */
const isDuplicateCustomerError = (error: unknown): boolean => {
    if (!(error instanceof Error)) {
        return false;
    }

    const { statusCode } = error as { statusCode?: unknown };

    if (typeof statusCode === "number" && statusCode !== 400 && statusCode !== 409) {
        return false;
    }

    return ALREADY_EXISTS_PATTERN.test(error.message);
};

const subscriptionFromCreem = (input: unknown): Subscription => {
    const subscription = asRecord(input);
    const now = Date.now();
    const status = readString(subscription, "status") ?? "";

    return {
        cancelAtPeriodEnd: isCanceling(subscription),
        createdAt: now,
        currentPeriodEnd: parseTimestamp(readAny(subscription, "current_period_end_date", "currentPeriodEndDate")),
        currentPeriodStart: parseTimestamp(readAny(subscription, "current_period_start_date", "currentPeriodStartDate")),
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
const checkoutToSession = (input: unknown): PaymentSession => {
    const checkout = asRecord(input);
    const now = Date.now();
    const order = asRecord(checkout.order);
    const currency = readString(order, "currency") ?? readString(checkout, "currency") ?? "usd";
    const amount = money(BigInt(Math.round(readNumber(order, "amount") ?? readNumber(checkout, "amount") ?? 0)), currency);
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

const mapEvent = (eventId: string, eventType: string, object: Record<string, unknown>): WebhookAction => {
    const base = { eventId, provider: "creem" as const, raw: { object, type: eventType } };
    const order = asRecord(object.order);
    const currency = readString(order, "currency") ?? readString(object, "currency") ?? "usd";

    switch (eventType) {
        case "checkout.completed": {
            const amount = readNumber(order, "amount") ?? readNumber(object, "amount");

            return {
                ...base,
                // Round before BigInt: Creem documents integer minor units, but a stray fractional amount
                // would throw a RangeError out of `parseWebhook` (a 400 → provider retry loop). Match Autumn.
                amount: amount === undefined ? undefined : money(BigInt(Math.round(amount)), currency),
                customerId: idOf(object.customer),
                referenceId: referenceFromMetadata(object),
                sessionId: readString(object, "id"),
                subscriptionId: idOf(object.subscription),
                type: "payment.captured",
            };
        }

        case "refund.created": {
            // Creem's refund object is flat: the amount lives in `refund_amount`/`refund_currency`
            // (not `amount`), and it references the original payment via a nested `transaction`
            // (fallback `subscription`), not an `order`. Read those first, keeping the legacy fields
            // as defensive fallbacks. Each event carries this single refund's amount, so the sync
            // layer's default "delta" interpretation is correct.
            const amount = readAnyNumber(object, "refund_amount", "refundAmount", "amount") ?? readNumber(order, "amount");
            const refundCurrency = readAny(object, "refund_currency", "refundCurrency") ?? currency;

            return {
                ...base,
                amount: amount === undefined ? undefined : money(BigInt(Math.round(amount)), refundCurrency),
                referenceId: referenceFromMetadata(object),
                // The event object IS the refund, so its `id` is this refund's id. Creem issues refunds
                // only from the dashboard (`refundPayment` throws), so no marker can ever match it —
                // carrying it still keeps a same-amount dashboard refund from consuming one.
                refundId: readString(object, "id"),
                // Key on the CHECKOUT id: `checkout.completed` writes the row under
                // `CheckoutEntity.id` (see `checkoutToSession`) and `getPaymentStatus` retrieves the
                // same id from `checkouts.retrieve`, so that is the only id a Creem payment row ever
                // has. `RefundEntity.transaction` is required while `checkout` is optional, so
                // reading `transaction` first always won and keyed every dashboard refund to a
                // `TransactionEntity.id` — a row that does not exist. The remaining reads are
                // fallbacks for a refund that carries no checkout at all; they orphan either way,
                // but they keep a stable key instead of falling through to the refund's own id.
                sessionId: idOf(object.checkout) ?? idOf(object.transaction) ?? idOf(object.subscription) ?? idOf(object.order) ?? readString(object, "id"),
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
                currentPeriodEnd: parseTimestamp(readAny(object, "current_period_end_date", "currentPeriodEndDate")),
                currentPeriodStart: parseTimestamp(readAny(object, "current_period_start_date", "currentPeriodStartDate")),
                customerId: idOf(object.customer),
                priceId: idOf(object.product),
                referenceId: referenceFromMetadata(object) ?? idOf(object.customer),
                subscriptionId: readString(object, "id"),
                // Fail closed before `stateToEventType` — an unmapped status must not degrade to a
                // state-preserving metadata patch.
                type: stateToEventType(SUBSCRIPTION_STATE_BY_CREEM_STATUS[status ?? ""] ?? "past_due"),
            };
        }

        default: {
            // dispute.created and any future event families — no state transition here.
            return { ...base, type: "unhandled" };
        }
    }
};

/**
 * `createCreemAdapter` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export const createCreemAdapter = (options: CreemAdapterOptions): PaymentAdapter => {
    const { webhookSecret } = options;
    // Use the injected client as the real `Creem` internally so every call is checked against the SDK.
    const client = options.client as unknown as Creem;

    return {
        // Creem is a Merchant-of-Record: it moves the money, so there is no manual payment-intent flow.
        cancelPayment: () => notSupported("manual payment cancellation"),

        cancelSubscription: async (subscriptionId, cancelOptions) =>
            // Creem supports both immediate and period-end cancellation via `mode`; omitting it defers
            // to the store's configured default, so pass it explicitly. Default (no `atPeriodEnd`) is
            // immediate, matching the other adapters. Creem reports the resulting state, which we return.
            subscriptionFromCreem(await client.subscriptions.cancel(subscriptionId, { mode: cancelOptions?.atPeriodEnd === true ? "scheduled" : "immediate" })),
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

            return { url: readAny(link, "customer_portal_link", "customerPortalLink") ?? "" };
        },

        getOrCreateCustomer: async (ref: CustomerRef): Promise<Customer> => {
            const toCustomer = (record: Record<string, unknown>): Customer => {
                return {
                    createdAt: Date.now(),
                    email: readString(record, "email") ?? ref.email,
                    id: readString(record, "id") ?? "",
                    provider: "creem",
                    referenceId: ref.referenceId,
                };
            };

            // Creem's `customers.create` is NOT idempotent by email — it returns 400 when a customer with
            // that email already exists, so a retried/raced first checkout would fail. Recover by looking
            // the existing customer up by email (Creem's `retrieve(customerId?, email?)` is positional).
            // The facade also gates this behind a store lookup first.
            try {
                return toCustomer(
                    asRecord(
                        await client.customers.create({
                            email: ref.email ?? "",
                            // Pin the framework-controlled `referenceId` LAST so caller metadata can never
                            // override it (same pattern as `createCheckout`) — this is the only thing Creem
                            // lets us key a customer on (no `externalId`-style create, unlike Polar/Dodo), so
                            // the recovery path below can verify it before ever adopting a retrieved customer.
                            metadata: { ...ref.metadata, referenceId: ref.referenceId },
                            name: ref.metadata?.name ?? ref.referenceId,
                        }),
                    ),
                );
            } catch (error) {
                // Only the known duplicate-email conflict is recoverable by an email lookup — a network
                // blip, quota error, or auth failure must propagate, not get reinterpreted as "go find the
                // existing customer" (which could silently adopt an unrelated one).
                if (ref.email !== undefined && isDuplicateCustomerError(error)) {
                    const existing = asRecord(await client.customers.retrieve(undefined, ref.email));
                    const existingReferenceId = referenceFromMetadata(existing);

                    // SECURITY: never bind this reference to a Creem customer minted for a DIFFERENT
                    // reference just because they share an email (two orgs/users can legitimately share
                    // one inbox). `createPortalSession` builds the hosted billing link from `customerId`
                    // alone, so adopting the wrong customer here would let one reference's portal expose
                    // another's subscriptions, invoices, and payment methods. Only the same-reference retry
                    // (the case this recovery path exists for) is adopted; anything else fails closed.
                    if (existingReferenceId !== ref.referenceId) {
                        throw new Error(
                            `Creem customer for email "${ref.email}" already belongs to a different reference; refusing to bind it to "${ref.referenceId}".`,
                            { cause: error },
                        );
                    }

                    return toCustomer(existing);
                }

                throw error;
            }
        },

        getPaymentStatus: async (sessionId) => checkoutToSession(await client.checkouts.retrieve(sessionId)),

        getSubscriptionStatus: async (subscriptionId) => subscriptionFromCreem(await client.subscriptions.get(subscriptionId)),

        identifier: "creem",

        parseWebhook: async ({ headers, payload }: WebhookInput): Promise<WebhookAction> => {
            await verifyCreemSignature({ payload, secret: webhookSecret, signature: headers.get("creem-signature") ?? "" });

            const event = asRecord(JSON.parse(payload));

            // Same multi-casing fallback as `eventType` below — Creem's `id` field name has drifted
            // across SDK/webhook versions too. `?? ""` here is only to satisfy `mapEvent`'s `string`
            // parameter (WebhookAction.eventId is non-optional) — it is NOT a "safe default": a blank
            // id still flows through as `eventId: ""`, and `applyWebhookAction`'s central guard
            // (sync.ts) is what actually rejects it before it can ever reach the dedupe store.
            return mapEvent(readAny(event, "id", "event_id", "eventId") ?? "", readAny(event, "eventType", "type") ?? "", asRecord(event.object));
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
