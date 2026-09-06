/**
 * Outbound idempotency keys.
 *
 * A key here is a stable string derived from our own operation + inputs, so a Worker retry of a
 * mutating provider call cannot repeat its effect. Distinct from inbound webhook dedupe (keyed on
 * the provider event id).
 *
 * **This only reaches the wire where the provider offers a surface for it, and most do not.** Only
 * Stripe carries a general per-request `idempotencyKey`; the other four adapters can key a call
 * only where the request body happens to have a field for it (Creem checkout's `requestId`, Dodo
 * usage ingestion's `event_id`, Polar usage ingestion's `externalId`). Everything else is sent
 * un-keyed, and a retry is a second call at the provider.
 *
 * The un-keyable calls that MOVE MONEY, and are therefore the real exposure:
 *
 * - `creem.ts` `subscriptions.upgrade` — `UpgradeSubscriptionRequestEntity` is `{ productId,
 * updateBehavior }` and Creem's `RequestOptions` has no key field. We pass
 * `updateBehavior: "proration-charge-immediately"`, so a retry charges the proration twice.
 * (Creem does understand `Idempotency-Key` on `products.create`, which takes it as an explicit
 * argument — nothing in the SDK says the subscription routes honour the same header.)
 * - `dodopayments.ts` `subscriptions.changePlan` — sent with
 * `proration_billing_mode: "prorated_immediately"`, so the same double-proration applies. See
 * the Dodo note below for why its typed key is not a fix.
 * - `autumn.ts` `billing.attach` (both the `createCheckout` and `updateSubscription` paths) —
 * `autumn-js` has no idempotency surface anywhere (zero matches for `idempot` in the package),
 * and attach charges the card immediately unless `invoiceMode` is set, which we do not set.
 * - Polar and Dodo `refunds.create` — Polar's `RefundCreate` is `{ metadata, orderId, reason,
 * amount, comment, revokeBenefits }`, with no key field and no working per-request option on
 * either SDK, so a retry genuinely issues a second refund. `create-payment.ts`'s `refundPayment`
 * still computes a key and hands it to the adapter; those two adapters have nowhere to put it.
 * The guard is local instead, and provider-agnostic: `refundPayment` records the refunded total
 * on the session row before returning, so the over-refund check rejects the retry without
 * reaching the adapter at all.
 *
 * Un-keyable and non-money-moving, for completeness: Creem `subscriptions.cancel` and
 * `customers.create`; Autumn `billing.update` (the cancel/uncancel pair); Dodo
 * `subscriptions.update`; and the hosted-checkout creators on Polar and Dodo (a checkout is a URL
 * the customer must still act on, so a duplicate is an abandoned session, not a charge).
 *
 * **Dodo's `RequestOptions.idempotencyKey` is inert.** The field is typed on every method, but the
 * client only turns it into a header when `this.idempotencyHeader` is set, and that property is
 * declared and read and never once assigned in the package — so the key we pass on
 * `customers.create` type-checks and never leaves the process. Dodo's only working idempotency in
 * this SDK version is body-level (`event_id` on usage ingestion), which we do use.
 *
 * **Two Stripe calls are un-keyed but trivially keyable** — `subscriptions.update` in
 * `resumeSubscription` and in `updateSubscription` (a plan/quantity change, so a money-moving
 * proration) are the only mutating Stripe calls in that adapter with no third `RequestOptions`
 * argument. Adding one is a follow-up, not a change to make blind.
 */
import type { Money } from "./types";

const encoder = new TextEncoder();

const sha256Hex = async (value: string): Promise<string> =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Build a deterministic idempotency key from an operation name and stable parts.
 * @experimental
 */
export const idempotencyKey = (operation: string, ...parts: ReadonlyArray<number | string>): string => [operation, ...parts.map(String)].join(":");

/**
 * Build a fixed-length idempotency key by hashing the request-shaping parts. Use this when the parts
 * can be long or arbitrary (checkout URLs + JSON metadata): Stripe rejects idempotency keys longer
 * than 255 characters, and two full redirect URLs plus metadata routinely exceed that. Hashing a
 * JSON-encoded parts array also removes the collision hazard of joining unescaped values with `:`
 * (distinct inputs can otherwise produce the same key within the provider's idempotency window).
 */
export const derivedIdempotencyKey = async (operation: string, provider: string, ...parts: ReadonlyArray<number | string>): Promise<string> => {
    const digest = await sha256Hex(JSON.stringify([provider, ...parts.map(String)]));

    return `${operation}:${provider}:${digest}`;
};

/**
 * Marker recording that the facade already folded ONE specific refund into `sessionId`'s row.
 *
 * Claimed (in the same store as inbound event ids) by `refundPayment` and consumed by the provider's
 * confirming `payment.refunded` webhook, so a DELTA provider's event — Polar, Creem, Dodo, which
 * report one refund each rather than a running total — does not add the same money a second time.
 * Absolute providers (Stripe) are idempotent without it, and an unconsumed marker is inert.
 *
 * The key is the provider's own `refundId` whenever there is one, because that is the only per-refund
 * identity: two in-flight refunds of the same amount on one session are two distinct refunds, and
 * keying on the amount would give them one shared marker, so one confirming event would be counted
 * twice. `amount` is the fallback for a provider that reports no refund id, and carries that
 * collision.
 */
export const localRefundKey = (sessionId: string, refundId: string | undefined, amount: Money): string =>
    refundId === undefined ? `local-refund:${sessionId}:${amount.currency}:${String(amount.minorUnits)}` : `local-refund:${sessionId}:id:${refundId}`;

/**
 * Claim `type` recorded for a {@link localRefundKey} marker. Internal bookkeeping, not a provider
 * delivery — the `marker.` prefix is what separates the two in the `events` audit log.
 */
export const LOCAL_REFUND_CLAIM_TYPE = "marker.local_refund";
