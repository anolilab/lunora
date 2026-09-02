/**
 * The payment facade.
 *
 * Wraps an adapter + store with the cross-cutting guarantees every call needs: per-caller
 * authorization (no IDOR), outbound idempotency keys (no double-charge), and webhook ingestion
 * that verifies, normalizes, and applies through the FSM.
 */
import { toErrorBody } from "@lunora/errors";

import { jsonResponse } from "../../../shared/json-response";
import type { PaymentAdapter } from "./adapter";
import type { Entitlements, EntitlementsConfig } from "./entitlements";
import { featureNames, hasActivePrice, resolveEntitlements, usagePeriodStart } from "./entitlements";
import { LunoraPaymentError } from "./errors";
import { derivedIdempotencyKey, idempotencyKey, LOCAL_REFUND_CLAIM_TYPE, localRefundKey } from "./idempotency";
import { addMoney, compareMoney, isZeroMoney, subtractMoney } from "./money";
import type { PaymentObserver } from "./observability";
import { notifyObserver } from "./observability";
import type { PaymentStore } from "./store";
import applyWebhookAction from "./sync";
import type {
    AttachInput,
    CancelSubscriptionOptions,
    CaptureInput,
    CheckInput,
    CheckoutInput,
    CheckoutResult,
    CheckResult,
    FeatureBalance,
    Money,
    PaymentSession,
    RefundInput,
    Subscription,
    TrackInput,
    TrackResult,
} from "./types";

/**
 * Strictly increasing event stamps for the usage ledger.
 *
 * The period total is a FOLD, not a sum (see `foldUsage`), so a `"set"` marker has
 * to be orderable against the `"add"` events around it — and `Date.now()` is
 * millisecond-granular, so a burst of `track` calls inside one millisecond would
 * otherwise share a stamp and fold in an arbitrary order. Handing out `max(now,
 * last + 1)` gives every event recorded by THIS isolate a distinct, ordered stamp
 * at no storage cost.
 *
 * Across isolates a same-millisecond tie falls back to the `idempotencyKey`
 * comparison in the fold. That is arbitrary, and deliberately so: those writes are
 * genuinely concurrent, so any order is a valid linearization and the fold's
 * last-writer-wins is the defined outcome — the property that matters is that
 * they cannot BOTH apply, which absolute markers guarantee.
 */
let lastUsageStamp = 0;

const nextUsageStamp = (): number => {
    const now = Date.now();

    lastUsageStamp = now > lastUsageStamp ? now : lastUsageStamp + 1;

    return lastUsageStamp;
};

/** The amount, as stable idempotency-key parts — a full-amount operation is its own distinct part. */
const amountPart = (amount: Money | undefined): string => (amount ? `${amount.currency}:${String(amount.minorUnits)}` : "full");

/** Drop a caller-supplied `referenceId` from checkout metadata — it's framework-controlled, never caller-set. */
const stripReferenceId = (metadata: Record<string, string> | undefined): Record<string, string> | undefined =>
    metadata && "referenceId" in metadata ? Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== "referenceId")) : metadata;

/**
 * What a `processWebhook`-shaped internal action hands back to the HTTP route: the
 * outcome plus the HTTP status the provider must actually see.
 * @experimental
 */
export interface WebhookOutcome {
    /** Whether the event advanced a row. A verified no-op/duplicate is `false`. */
    applied: boolean;
    /** The status {@link LunoraPayment.handleWebhook} answered — 500 for an orphaned event. */
    status: number;
}

/**
 * Turn a {@link WebhookOutcome} back into the HTTP response the provider must see.
 *
 * The webhook endpoint runs at the Worker edge (signature verification needs the raw
 * body) and forwards into the shard via `ctx.runAction`, so `handleWebhook`'s own
 * `Response` cannot cross the action boundary — only its JSON payload can. A route
 * that answers `Response.json(result)` therefore collapses every outcome to `200`,
 * including the deliberate `500` on an orphaned (out-of-order) event: the provider
 * stops retrying and that event is lost for good. Call this from the route instead
 * of building the response by hand.
 * @experimental
 */
export const webhookResponse = (result: WebhookOutcome): Response => jsonResponse({ applied: result.applied }, result.status);

/**
 * Returns whether the current caller may act on `referenceId`. Throwing is also treated as denial.
 * @experimental
 */
export type AuthorizeReference = (referenceId: string) => boolean | Promise<boolean>;

/**
 * `CreatePaymentOptions` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export interface CreatePaymentOptions {
    readonly adapter: PaymentAdapter;

    /**
     * Per-caller authorization for every mutation. Return `false` to reject with 403. Omit only
     * for trusted server-internal callers (e.g. the reconciliation sweep).
     */
    readonly authorize?: AuthorizeReference;
    /** Plan → features/limits map. Required for `check`; omit if you don't gate features. */
    readonly entitlements?: EntitlementsConfig;
    /** Optional telemetry sink — fired on webhook apply, failed payments, and past-due subscriptions. */
    readonly observability?: PaymentObserver;
    readonly store: PaymentStore;
}

/**
 * `LunoraPayment` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export interface LunoraPayment {
    readonly adapter: PaymentAdapter;

    /**
     * Subscribe a reference to a plan — a plan-oriented alias of {@link LunoraPayment.createCheckout}
     * with `mode` defaulting to `"subscription"`. Returns a hosted-checkout URL to redirect to.
     */
    attach: (input: AttachInput) => Promise<CheckoutResult>;
    /** Cancel the caller's own uncaptured payment (authorized, derived idempotency key, store synced). */
    cancelPayment: (sessionId: string, options?: { idempotencyKey?: string }) => Promise<PaymentSession>;
    cancelSubscription: (subscriptionId: string, options?: CancelSubscriptionOptions) => Promise<Subscription>;
    /** Capture the caller's own authorized payment (authorized, derived idempotency key, store synced). */
    capturePayment: (input: CaptureInput) => Promise<PaymentSession>;

    /**
     * Is a reference allowed something right now? Pass `featureId` to check a grant/allowance (boolean
     * features check plan grants; metered features subtract usage tracked this period) or `priceId` to
     * check active access to a product. The feature path requires `entitlements` to be configured.
     */
    check: (input: CheckInput) => Promise<CheckResult>;
    createCheckout: (input: CheckoutInput) => Promise<CheckoutResult>;
    /** Open the provider billing portal for the caller's own customer (derived from the store). */
    createPortalSession: (referenceId: string, returnUrl: string) => Promise<{ url: string }>;

    /**
     * Verify + normalize + apply a provider webhook. 200 once verified, even on a no-op — except an
     * event whose target row doesn't exist yet, which returns 500 so the provider redelivers it once.
     */
    handleWebhook: (request: Request) => Promise<Response>;
    /** Resolve every configured feature's allowance for a reference in one call. Requires `entitlements`. */
    listBalances: (referenceId: string) => Promise<FeatureBalance[]>;
    listSubscriptions: (referenceId: string) => Promise<Subscription[]>;
    /** Refund the caller's own captured payment (authorized, derived idempotency key, store synced). */
    refundPayment: (input: RefundInput) => Promise<PaymentSession>;
    readonly store: PaymentStore;

    /**
     * Record metered usage for a reference's feature — durably (exactly-once by idempotency key) and,
     * when the provider supports it, forwarded to its metering API. Best-effort upstream: a reporting
     * failure is observed, never thrown, and the local ledger that `check` reads is always updated.
     */
    track: (input: TrackInput) => Promise<TrackResult>;
}

/**
 * `createPayment` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export const createPayment = (options: CreatePaymentOptions): LunoraPayment => {
    const { adapter, store } = options;

    const ensureAuthorized = async (referenceId: string): Promise<void> => {
        if (!options.authorize) {
            return;
        }

        let allowed: boolean;

        try {
            allowed = await options.authorize(referenceId);
        } catch {
            // A throwing authorizer denies by policy.
            throw new LunoraPaymentError("FORBIDDEN", `caller not authorized for reference "${referenceId}"`);
        }

        if (!allowed) {
            throw new LunoraPaymentError("FORBIDDEN", `caller not authorized for reference "${referenceId}"`);
        }
    };

    // Shared by `createCheckout` and `attach`: reuse the reference's stored provider customer, only
    // minting a new one the first time, then delegate to the adapter with an outbound idempotency key.
    const startCheckout = async (input: CheckoutInput): Promise<CheckoutResult> => {
        await ensureAuthorized(input.referenceId);

        // `referenceId` is the tenant-isolation key and is framework-controlled: never let caller-supplied
        // checkout metadata smuggle a `referenceId` override that decouples the attributed owner from the
        // authorized one. Strip it here so the invariant holds regardless of adapter spread order.
        const metadata = stripReferenceId(input.metadata);

        // Never trust a caller-supplied `input.customerId` (cross-tenant checkout IDOR): the authorizer
        // covers only `referenceId`, so honoring a client-set customer id would bind the authorized
        // reference's checkout to an arbitrary provider customer. Always derive the customer from the
        // store for the authorized reference — mirroring `createPortalSession` — minting one only the
        // first time. `input.customerId` is intentionally ignored (kept on the type for back-compat).
        let customerId: string;
        const existing = await store.getCustomerByReference(adapter.identifier, input.referenceId);

        if (existing) {
            customerId = existing.id;
        } else {
            const customer = await adapter.getOrCreateCustomer({ email: input.email, referenceId: input.referenceId });

            customerId = customer.id;
            await store.upsertCustomer(customer);
        }

        // Derive a key over every request-shaping field, not just (reference, price, mode): a second
        // checkout that changes quantity/URLs/metadata must not collide with the provider's idempotency
        // window (which would error or return the stale earlier session). Hash the parts so the key stays
        // a fixed length (Stripe rejects keys >255 chars, and two full URLs + metadata routinely exceed
        // that) and can't collide via unescaped `:` joining of the URLs/metadata.
        const key =
            input.idempotencyKey ??
            (await derivedIdempotencyKey(
                "checkout",
                adapter.identifier,
                input.referenceId,
                input.priceId,
                input.mode,
                String(input.quantity ?? 1),
                input.successUrl,
                input.cancelUrl,
                metadata ? JSON.stringify(metadata) : "",
            ));

        return adapter.createCheckout({ ...input, customerId, idempotencyKey: key, metadata });
    };

    // Resolve one feature's allowance — shared by `check` and `listBalances`. A metered feature
    // (numeric plan limit) subtracts usage tracked this period; a boolean feature is granted or not.
    // The balance arithmetic for a metered feature — shared by the single-feature `check` path and
    // the batched `listBalances` path so the two can never disagree.
    const meteredResult = (limit: number, used: number, need: number): CheckResult => {
        const balance = limit - used;

        return { allowed: balance >= need, balance, limit, unlimited: false, used };
    };

    const evaluateFeature = async (
        entitlements: Entitlements,
        subscriptions: ReadonlyArray<Subscription>,
        referenceId: string,
        featureId: string,
        need: number,
    ): Promise<CheckResult> => {
        const limit = entitlements.limit(featureId);

        if (limit !== undefined) {
            const used = await store.sumUsage(referenceId, featureId, usagePeriodStart(subscriptions));

            return meteredResult(limit, used, need);
        }

        return { allowed: entitlements.has(featureId), unlimited: entitlements.has(featureId) };
    };

    // Shared ownership guard for the money-moving session operations. Collapse "doesn't exist" and
    // "not yours" into one indistinguishable NOT_FOUND so the endpoint can't be used as a
    // cross-tenant existence oracle (same posture as `cancelSubscription`).
    const ownedSession = async (sessionId: string): Promise<PaymentSession> => {
        // Every failure below raises the SAME message: `toErrorBody` echoes a payment error's message
        // verbatim to the caller, so varying it by cause would rebuild the existence oracle this
        // collapse exists to prevent.
        const notFound = (): LunoraPaymentError => new LunoraPaymentError("NOT_FOUND", `payment session "${sessionId}" not found`);

        let existing = await store.getPaymentSession(adapter.identifier, sessionId);

        // No local row yet is normal, not an error: an authorize-then-capture inside one request, and
        // any manual-capture flow driven by `payment_intent.*`, runs before the webhook that creates
        // the row. Ask the provider before giving up, so those flows work through the facade.
        if (!existing) {
            try {
                existing = await adapter.getPaymentStatus(sessionId);
            } catch {
                throw notFound();
            }
        }

        // Nothing to authorize against — refuse rather than let an unowned session through.
        if (!existing.referenceId) {
            throw notFound();
        }

        try {
            await ensureAuthorized(existing.referenceId);
        } catch {
            throw notFound();
        }

        return existing;
    };

    /**
     * Persist an adapter result onto the stored row.
     *
     * An adapter returns a PROVIDER-shaped session, not a store row: Polar's `refundPayment` pins
     * `amount`/`capturedAmount` to the refund amount and blanks `referenceId`, and Stripe's
     * `intentToSession` blanks `referenceId` for any checkout-originated intent (the reference lives
     * on the checkout session, not the PaymentIntent). Writing one verbatim would wipe the captured
     * total and orphan the row from `by_reference`, leaving it unauthorizable — and so permanently
     * unrefundable. Merge the way the webhook path does (`sync.ts`): the stored row owns identity and
     * money, and each operation contributes only the fields it actually establishes.
     */
    const persistSession = async (existing: PaymentSession, patch: Partial<PaymentSession>): Promise<PaymentSession> => {
        const merged: PaymentSession = { ...existing, ...patch, updatedAt: Date.now() };

        await store.upsertPaymentSession(merged);

        return merged;
    };

    return {
        adapter,

        attach: async (input) => startCheckout({ ...input, mode: input.mode ?? "subscription" }),

        cancelPayment: async (sessionId, cancelOptions) => {
            const existing = await ownedSession(sessionId);

            const key = cancelOptions?.idempotencyKey ?? idempotencyKey("cancel_payment", adapter.identifier, sessionId);
            const updated = await adapter.cancelPayment(sessionId, { ...cancelOptions, idempotencyKey: key });

            // A cancel establishes the state and nothing else — the amounts on the row stand.
            return persistSession(existing, { state: updated.state });
        },

        cancelSubscription: async (subscriptionId, cancelOptions) => {
            const existing = await store.getSubscription(adapter.identifier, subscriptionId);

            // Collapse "doesn't exist" and "not yours" into one indistinguishable NOT_FOUND so the
            // endpoint can't be used as a cross-tenant existence oracle. A non-owner authorizer denial
            // is rewritten to the same 404 as a genuinely missing id.
            if (!existing) {
                throw new LunoraPaymentError("NOT_FOUND", `subscription "${subscriptionId}" not found`);
            }

            try {
                await ensureAuthorized(existing.referenceId);
            } catch {
                throw new LunoraPaymentError("NOT_FOUND", `subscription "${subscriptionId}" not found`);
            }

            const key = cancelOptions?.idempotencyKey ?? idempotencyKey("cancel_subscription", adapter.identifier, subscriptionId);
            const updated = await adapter.cancelSubscription(subscriptionId, { ...cancelOptions, idempotencyKey: key });

            await store.upsertSubscription(updated);

            return updated;
        },

        capturePayment: async (input) => {
            const existing = await ownedSession(input.sessionId);

            // The amount is part of the key: `CaptureInput` supports partial captures, and reusing one
            // key across two different amounts makes the provider reject the second call as a
            // parameter mismatch — while two identical ones must still replay rather than double-charge.
            const key = input.idempotencyKey ?? (await derivedIdempotencyKey("capture_payment", adapter.identifier, input.sessionId, amountPart(input.amount)));
            const updated = await adapter.capturePayment({ ...input, idempotencyKey: key });

            // The provider's captured total is authoritative here, and its own `payment.captured`
            // webhook later ASSIGNS the same value (never accumulates), so both paths agree.
            return persistSession(existing, { capturedAmount: updated.capturedAmount, state: updated.state });
        },

        check: async (input) => {
            await ensureAuthorized(input.referenceId);

            // Validate the argument shape BEFORE any delegation, so misuse fails the same way on every
            // provider — otherwise a `check({ referenceId })` with neither `featureId` nor `priceId`
            // would reach a provider-owned adapter unscoped and could fail open ("customer exists").
            if (input.featureId === undefined && input.priceId === undefined) {
                throw new LunoraPaymentError("CONFIG_INVALID", "check() requires a featureId or priceId");
            }

            // When the provider owns entitlement truth (e.g. Autumn), delegate the whole decision to
            // it — its live balances/credits/limits are authoritative, and the app need not mirror
            // plan limits into `entitlements`.
            if (adapter.checkEntitlement) {
                return adapter.checkEntitlement(input);
            }

            const subscriptions = await store.listSubscriptionsByReference(input.referenceId);

            // Product access check: is there an active subscription on this price/product?
            if (input.priceId !== undefined) {
                return { allowed: hasActivePrice(subscriptions, input.priceId), unlimited: false };
            }

            // Unreachable at runtime — the arg-shape guard above already rejected "neither", and the
            // priceId branch returned. This narrows `featureId` to `string` for `evaluateFeature` below.
            if (input.featureId === undefined) {
                throw new LunoraPaymentError("CONFIG_INVALID", "check() requires a featureId or priceId");
            }

            if (!options.entitlements) {
                throw new LunoraPaymentError("CONFIG_INVALID", "check() requires `entitlements` to be configured");
            }

            const entitlements = resolveEntitlements(options.entitlements, subscriptions);

            return evaluateFeature(entitlements, subscriptions, input.referenceId, input.featureId, input.quantity ?? 1);
        },

        createCheckout: async (input) => startCheckout(input),

        createPortalSession: async (referenceId, returnUrl) => {
            await ensureAuthorized(referenceId);

            // Derive the customer from the store — never trust a caller-supplied customer id (IDOR).
            const customer = await store.getCustomerByReference(adapter.identifier, referenceId);

            if (!customer) {
                throw new LunoraPaymentError("NOT_FOUND", `no customer for reference "${referenceId}"`);
            }

            return adapter.createPortalSession({ customerId: customer.id, returnUrl });
        },

        handleWebhook: async (request) => {
            let action;

            try {
                const payload = await request.text();

                action = await adapter.parseWebhook({ headers: request.headers, payload });
            } catch (error) {
                // Only surface our own (non-sensitive) error messages; mask anything
                // unexpected. Routed through `toErrorBody` so a payment code's
                // echo-vs-redact posture is governed centrally by the shared
                // catalog rather than solely by this `instanceof` check — today no
                // `PaymentErrorCode` is catalog-marked internal, so this preserves
                // the exact message/status `LunoraPaymentError` already carries.
                if (error instanceof LunoraPaymentError) {
                    const { body, status } = toErrorBody(error);

                    return jsonResponse({ error: body.message }, status);
                }

                return jsonResponse({ error: "webhook error" }, 400);
            }

            // Deliberately outside the try/catch above: a thrown LunoraPaymentError (e.g.
            // WEBHOOK_EVENT_ID_MISSING) surfaces uncaught as a 5xx rather than its catalog 400, so
            // every provider retries the transient malformed delivery instead of some providers
            // treating a 400 as "stop retrying". Do not wrap this call in the parseWebhook try/catch.
            const result = await applyWebhookAction(store, action, options.observability);

            // Deliberate non-200: the row this event patches hasn't been created yet (out-of-order
            // delivery), and its claim was released — the provider must retry so the update applies
            // once the create event lands. Only `orphaned` gets this; genuinely unhandleable events
            // keep the always-200 contract below.
            if (result.reason === "orphaned") {
                return jsonResponse({ applied: result.applied, reason: result.reason }, 500);
            }

            // Every other outcome acknowledges: once verified, a no-op is still a 200 and the provider
            // stops retrying.
            return jsonResponse({ applied: result.applied, reason: result.reason }, 200);
        },

        listBalances: async (referenceId) => {
            await ensureAuthorized(referenceId);

            // Provider-owned entitlements (e.g. Autumn): read the live balances straight from it.
            if (adapter.getBalances) {
                return adapter.getBalances(referenceId);
            }

            if (!options.entitlements) {
                throw new LunoraPaymentError("CONFIG_INVALID", "listBalances() requires `entitlements` to be configured");
            }

            const subscriptions = await store.listSubscriptionsByReference(referenceId);
            const entitlements = resolveEntitlements(options.entitlements, subscriptions);
            const names = featureNames(options.entitlements);
            const metered = names.filter((featureId) => entitlements.limit(featureId) !== undefined);
            // One batched ledger read for every metered feature instead of one unbounded scan each.
            const usage =
                metered.length === 0 ? new Map<string, number>() : await store.sumUsageByFeature(referenceId, metered, usagePeriodStart(subscriptions));

            // `names` is already sorted; mapping it preserves the order.
            return names.map((featureId) => {
                const limit = entitlements.limit(featureId);

                if (limit !== undefined) {
                    return { featureId, ...meteredResult(limit, usage.get(featureId) ?? 0, 1) };
                }

                return { featureId, allowed: entitlements.has(featureId), unlimited: entitlements.has(featureId) };
            });
        },

        listSubscriptions: async (referenceId) => {
            await ensureAuthorized(referenceId);

            return store.listSubscriptionsByReference(referenceId);
        },

        refundPayment: async (input) => {
            const existing = await ownedSession(input.sessionId);

            // Resolve the resulting refunded total BEFORE moving money: a mismatched currency or an
            // over-refund must fail with nothing issued, not leave a refund the ledger can't record.
            // A full refund issues whatever is left unrefunded, which is also the amount the provider
            // will report on the confirming webhook.
            const issued = input.amount ?? subtractMoney(existing.capturedAmount, existing.refundedAmount);
            const refunded = addMoney(existing.refundedAmount, issued);

            if (compareMoney(refunded, existing.capturedAmount) > 0) {
                throw new LunoraPaymentError(
                    "VALIDATION_ERROR",
                    `refundPayment(): refunding ${String(input.amount?.minorUnits)} would exceed the captured amount on session "${input.sessionId}"`,
                );
            }

            // Nothing left to refund — the ledger already holds the whole captured amount. Return the
            // row as it stands instead of asking the provider to move zero (Polar would read the order
            // total and refund it a second time; the guard above cannot catch that, because `issued` is
            // zero and the total does not move).
            if (isZeroMoney(issued)) {
                return existing;
            }

            // What the PROVIDER is asked to refund. An omitted `input.amount` means "whatever is left",
            // which is not the same thing as "the whole order": Polar's refund endpoint takes the order
            // total when no amount is given (`providers/polar.ts`), so a full refund of a partially
            // refunded session would move the total a second time while the ledger records only the
            // remainder. Send the resolved remainder instead.
            //
            // The amount stays absent when the remainder IS the captured total, so a provider that can
            // only refund in full keeps working; when the two differ, that provider rejects the call
            // (Dodo throws PROVIDER_ERROR for any explicit amount) — which is the right answer, since
            // it cannot express the refund being asked for.
            const providerAmount = input.amount ?? (compareMoney(issued, existing.capturedAmount) === 0 ? undefined : issued);

            // Amount and reason are part of the key — see `capturePayment`; partial refunds of one
            // session are legitimate and must not collide on the provider's idempotency window. It is
            // the amount actually sent that keys it, so a full-refund-of-a-remainder and an explicit
            // refund of the same remainder are one operation rather than two.
            const key =
                input.idempotencyKey ??
                (await derivedIdempotencyKey("refund_payment", adapter.identifier, input.sessionId, amountPart(providerAmount), input.reason ?? ""));

            const issuedRefund = await adapter.refundPayment({ ...input, amount: providerAmount, idempotencyKey: key });

            // A refund the provider has NOT settled yet moves no money and must not be written to the
            // ledger. Dodo answers `refunds.create` with `pending`/`review` and only later sends
            // `refund.succeeded` — or `refund.failed`, which maps to `unhandled` and reverses nothing,
            // so an optimistically recorded amount would over-state the row forever. Leave the row
            // untouched and let the confirming `payment.refunded` webhook carry the money; no marker
            // either, or that webhook would be zeroed and the refund would never land at all.
            //
            // The cost is that the local ledger cannot guard a retry during the pending window. That is
            // the lesser evil: a retry is bounded and visible, an over-stated refunded total is neither
            // (it also blocks every later legitimate refund through the over-refund guard above).
            if (issuedRefund.pending) {
                return existing;
            }

            const marker = localRefundKey(input.sessionId, issuedRefund.refundId, issued);

            // Record the refund on the row NOW rather than waiting for the provider's webhook. This
            // ledger is the only thing standing between a retried (or repeated) call and a second
            // real refund: Polar's refund endpoint accepts no idempotency key at all, so the key
            // above cannot dedupe it on the wire (`idempotency.ts`). With the total written, the
            // over-refund guard above rejects the retry before the adapter is reached.
            //
            // The confirming webhook then restates the same money. `sync.ts` folds it in without
            // double-counting: a cumulative-total provider resolves to `max(...)`, and a per-refund
            // (delta) provider's event consumes this marker and contributes nothing. The marker is keyed
            // on the provider's id for THIS refund, so two in-flight refunds of the same amount on one
            // session leave two markers and each confirming event consumes its own.
            //
            // The state is derived locally too — from the amount this call refunds, not from the
            // adapter's own state, which Polar pins to "refunded" for a partial refund as well.
            await store.markEventProcessed(adapter.identifier, marker, LOCAL_REFUND_CLAIM_TYPE);

            try {
                return await persistSession(existing, {
                    refundedAmount: refunded,
                    state: compareMoney(refunded, existing.capturedAmount) < 0 ? "partially_refunded" : "refunded",
                });
            } catch (error) {
                // The marker is claimed BEFORE the row, because the confirming webhook can arrive while
                // this write is still in flight and must not double-count. There is no transaction across
                // the two stores, so if the row write fails the claim would outlive the fold it stands
                // for: the delta provider's `payment.refunded` would consume it, contribute nothing, and
                // the refund would be absent from the row entirely. Release it so that webhook carries
                // the money instead — the same claim/rollback shape `sync.ts` uses around `applyPayment`.
                //
                // KNOWN WINDOW: a hard isolate kill between the two writes still strands the marker, and
                // it is inert only until this refund's webhook consumes it. Closing that needs a
                // conditional write on `PaymentStore` (the DB store's `patch` compare-and-swaps on the
                // pre-image it reads itself, which a caller cannot supply), not an ordering change —
                // writing the row first only trades a lost refund for a double-counted one.
                await store.releaseEvent(adapter.identifier, marker);

                throw error;
            }
        },

        store,

        track: async (input) => {
            await ensureAuthorized(input.referenceId);

            // `=== undefined`, not `??`. The two are equivalent to the TYPE (`number |
            // undefined`), which is why the lint rule cannot tell them apart — but
            // this is a trust boundary, and an untyped/JSON caller can send
            // `quantity: null`. `??` would quietly turn that into the default 1
            // instead of letting the check below reject it.
            // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- deliberate: `??` would swallow a runtime `null` the type says can't happen
            const target = input.quantity === undefined ? 1 : input.quantity;

            // A negative (or non-integer/non-finite) quantity is never a legitimate
            // meter reading, and it is not merely garbage-in: the ledger is summed
            // to `used`, and `evaluateFeature` derives `balance = limit - used`, so
            // a negative event pushes `used` below zero and hands the caller an
            // unbounded balance past its paid cap. Reject at the boundary — for
            // BOTH modes ("set" to a negative total is the same bypass in one call).
            if (!Number.isSafeInteger(target) || target < 0) {
                throw new LunoraPaymentError("VALIDATION_ERROR", `track(): \`quantity\` must be a non-negative safe integer (got ${String(input.quantity)})`);
            }
            // A caller-stable key dedupes retries; an omitted one means "always record".
            const key = input.idempotencyKey ?? crypto.randomUUID();

            // Both modes are a single append — the ledger is append-only and the
            // period total is a FOLD over it (`foldUsage`), not a plain sum: an
            // "add" event increments, a "set" event resets the total to its own
            // quantity and discards everything earlier in the period.
            //
            // CONCURRENCY: that fold is the whole point. Reconciling a "set" the
            // obvious way — read the current total, append `target - current` —
            // is a read-modify-write across two un-transacted store calls, so two
            // interleaved "set" calls both read the same total, both append a
            // delta, and leave the period over- or under-counted, which inflates
            // `balance = limit - used` exactly like a negative quantity would.
            // Appending the absolute target instead makes concurrent "set" calls
            // resolve last-writer-wins and a replayed "set" idempotent, with no
            // lock and no serialized-context requirement. "add" was never at risk
            // (its increment is independent of the current total).
            const isSet = input.mode === "set";

            // Advisory ONLY: skip a "set" that already matches, and an explicit
            // `add 0`, so the ledger doesn't grow for a no-op. A stale read here
            // can only cost a redundant marker — never a wrong total — because the
            // fold resolves the period regardless of what this read saw. Nothing
            // downstream depends on it, which is what keeps the path race-free.
            const subscriptions = isSet ? await store.listSubscriptionsByReference(input.referenceId) : undefined;
            const current = subscriptions === undefined ? 0 : await store.sumUsage(input.referenceId, input.featureId, usagePeriodStart(subscriptions));

            if (isSet ? target === current : target === 0) {
                return { recorded: false, reportedToProvider: false };
            }

            // What this event moves the period total BY — the increment for "add",
            // and for "set" the best-effort difference from the total just read.
            // Local enforcement never uses it (the fold does); it exists only for
            // the additive upstream meter below, which is already best-effort and
            // reconciled separately.
            const delta = isSet ? target - current : target;

            const recorded = await store.recordUsage({
                createdAt: nextUsageStamp(),
                featureId: input.featureId,
                idempotencyKey: key,
                ...(isSet ? { mode: "set" as const } : {}),
                provider: adapter.identifier,
                quantity: target,
                referenceId: input.referenceId,
                reportedToProvider: false,
            });

            // A duplicate must not double-report upstream — bail before touching the provider.
            if (!recorded) {
                return { recorded: false, reportedToProvider: false };
            }

            // Provider meters are additive: only forward positive deltas (a "set" that lowers usage,
            // or a no-op, stays local). For a locally-evaluated provider the ledger `check` reads is
            // authoritative; for a provider that OWNS entitlements (`checkEntitlement`/`getBalances`),
            // the provider's meter is authoritative and this forward is what `check` will later read —
            // a swallowed forward failure below means the usage isn't enforced until `reconcile`.
            if (delta <= 0 || !adapter.capabilities.usageMetering || !adapter.reportUsage) {
                return { recorded: true, reportedToProvider: false };
            }

            try {
                const customer = await store.getCustomerByReference(adapter.identifier, input.referenceId);

                await adapter.reportUsage({
                    customerId: customer?.id,
                    featureId: input.featureId,
                    idempotencyKey: key,
                    quantity: delta,
                    referenceId: input.referenceId,
                });
                await store.markUsageReported(adapter.identifier, key);

                return { recorded: true, reportedToProvider: true };
            } catch {
                // Upstream metering is best-effort: the durable ledger is already updated, so a
                // transient provider error can never fail the caller's request. For a locally-evaluated
                // provider that ledger is what `check` reads; for a provider that owns entitlements the
                // row stays `reportedToProvider: false` and `reconcile` retries the forward from
                // `store.listUnreportedUsage` (plus this `usage.report_failed` signal for alerting).
                notifyObserver(options.observability, {
                    featureId: input.featureId,
                    provider: adapter.identifier,
                    referenceId: input.referenceId,
                    type: "usage.report_failed",
                });

                return { recorded: true, reportedToProvider: false };
            }
        },
    };
};
