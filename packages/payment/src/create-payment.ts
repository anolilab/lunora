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
import { derivedIdempotencyKey, LOCAL_REFUND_CLAIM_TYPE, localRefundKey } from "./idempotency";
import { addMoney, compareMoney, isZeroMoney, maxMoney, subtractMoney } from "./money";
import type { PaymentObserver } from "./observability";
import { notifyObserver } from "./observability";
import type { PaymentStore } from "./store";
import { overlayProviderSubscription } from "./store";
import applyWebhookAction from "./sync";
import type {
    AttachInput,
    CancelSubscriptionOptions,
    CaptureInput,
    CheckInput,
    CheckoutRequest,
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

/**
 * A caller's `quantity`, defaulting to `1`. Must be a non-negative safe integer: a negative one drives
 * `balance = limit - used` past the cap. `=== undefined`, not `??`, so a JSON `null` is rejected.
 */
const requireQuantity = (method: string, value: number | undefined): number => {
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- `??` would turn a runtime `null` into the default
    const quantity = value === undefined ? 1 : value;

    if (!Number.isSafeInteger(quantity) || quantity < 0) {
        throw new LunoraPaymentError("VALIDATION_ERROR", `${method}(): \`quantity\` must be a non-negative safe integer (got ${String(value)})`);
    }

    return quantity;
};

/** Drop a caller-supplied `referenceId` from checkout metadata — it's framework-controlled, never caller-set. */
const stripReferenceId = (metadata: Record<string, string> | undefined): Record<string, string> | undefined =>
    metadata && "referenceId" in metadata ? Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== "referenceId")) : metadata;

/**
 * What a `processWebhook`-shaped internal action hands back to the HTTP route: the
 * outcome plus the HTTP status the provider must actually see.
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
 */
export const webhookResponse = (result: WebhookOutcome): Response => jsonResponse({ applied: result.applied }, result.status);

/**
 * Returns whether the current caller may act on `referenceId`. Throwing is also treated as denial.
 */
export type AuthorizeReference = (referenceId: string) => boolean | Promise<boolean>;

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
    createCheckout: (input: CheckoutRequest) => Promise<CheckoutResult>;
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

    /**
     * Refund the caller's own captured payment (authorized, derived idempotency key, store synced).
     *
     * The derived key makes "same session, same amount, same reason" ONE operation, so a retried
     * request cannot refund twice. Two *intentional* refunds of the same amount on one session are
     * therefore indistinguishable from that retry: pass a distinct `RefundInput.idempotencyKey` for
     * the second one, or the provider replays the first and the second moves no money.
     */
    refundPayment: (input: RefundInput) => Promise<PaymentSession>;
    readonly store: PaymentStore;

    /**
     * Record metered usage for a reference's feature — durably (exactly-once by idempotency key) and,
     * when the provider supports it, forwarded to its metering API. Best-effort upstream: a reporting
     * failure is observed, never thrown, and the local ledger that `check` reads is always updated.
     *
     * `mode: "set"` is rejected with `VALIDATION_ERROR` on a provider that meters usage: its meter is
     * additive, so a period total is not expressible on it and a lowering set would leave the provider
     * billing more than the local ledger holds. Use `mode: "add"` there.
     */
    track: (input: TrackInput) => Promise<TrackResult>;
}

export const createPayment = (options: CreatePaymentOptions): LunoraPayment => {
    const { adapter, store } = options;

    const ensureAuthorized = async (referenceId: string): Promise<void> => {
        if (!options.authorize) {
            return;
        }

        // `unknown`, compared to an exact `true`. The authorizer is app code and
        // untyped JavaScript reaches it, so a verdict object (`{ allowed: false }`,
        // a settled promise result, a row) would be TRUTHY and authorize a charge
        // against someone else's reference. A throw denies too.
        let allowed: unknown;

        try {
            allowed = await options.authorize(referenceId);
        } catch {
            // A throwing authorizer denies by policy.
            throw new LunoraPaymentError("FORBIDDEN", `caller not authorized for reference "${referenceId}"`);
        }

        if (allowed !== true) {
            throw new LunoraPaymentError("FORBIDDEN", `caller not authorized for reference "${referenceId}"`);
        }
    };

    // The outbound key for `operation` on the object `scope` names. Provider keys are account-wide, so
    // a caller's key is namespaced to that object (one tenant can't claim or replay another's); without
    // one the key derives from the request-shaping `parts`. Hashed, so it stays under Stripe's 255 chars.
    const outboundKey = async (
        operation: string,
        scope: ReadonlyArray<string>,
        key: string | undefined,
        parts: () => ReadonlyArray<number | string>,
    ): Promise<string> => derivedIdempotencyKey(operation, adapter.identifier, ...scope, ...(key === undefined ? parts() : [key]));

    // Shared by `createCheckout` and `attach`: reuse the reference's stored provider customer, only
    // minting a new one the first time, then delegate to the adapter with an outbound idempotency key.
    const startCheckout = async (input: CheckoutRequest): Promise<CheckoutResult> => {
        await ensureAuthorized(input.referenceId);

        // `referenceId` is the tenant-isolation key and is framework-controlled: never let caller-supplied
        // checkout metadata smuggle a `referenceId` override that decouples the attributed owner from the
        // authorized one. Strip it here so the invariant holds regardless of adapter spread order.
        const metadata = stripReferenceId(input.metadata);

        // The customer comes from the store for the authorized reference (as in `createPortalSession`),
        // minted only the first time — never from the caller, which would be a cross-tenant IDOR.
        let customer = await store.getCustomerByReference(adapter.identifier, input.referenceId);

        if (!customer) {
            customer = await adapter.getOrCreateCustomer({ email: input.email, referenceId: input.referenceId });

            if (customer) {
                await store.upsertCustomer(customer);
            }
        }

        // Every request-shaping field is part of the key, so a changed checkout is a new request
        // rather than a replay (or a provider-side mismatch) of the earlier one.
        const key = await outboundKey("checkout", [input.referenceId], input.idempotencyKey, () => [
            input.priceId,
            input.mode,
            String(input.quantity ?? 1),
            input.successUrl,
            input.cancelUrl ?? "",
            metadata ? JSON.stringify(metadata) : "",
        ]);

        return adapter.createCheckout({ ...input, customerId: customer?.id, idempotencyKey: key, metadata });
    };

    // The balance arithmetic for a metered feature, shared by `check` and `listBalances`.
    const meteredResult = (limit: number, used: number, need: number): CheckResult => {
        const balance = limit - used;

        return { allowed: balance >= need, balance, limit, unlimited: false, used };
    };

    // One feature's allowance: a metered feature (numeric plan limit) subtracts usage tracked this
    // period; a boolean feature is granted or not.
    const evaluateFeature = async (entitlements: Entitlements, referenceId: string, featureId: string, need: number): Promise<CheckResult> => {
        const limit = entitlements.limit(featureId);

        if (limit !== undefined) {
            return meteredResult(limit, await store.sumUsage(referenceId, featureId, entitlements.periodStart(featureId)), need);
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

    // Merge an adapter result onto the stored row. An adapter returns a PROVIDER-shaped session (Polar
    // pins the amounts to the refund, Stripe blanks `referenceId`), so the stored row owns identity and
    // money and each operation patches only the fields it establishes. The patch applies to the row
    // RE-READ after the provider call, so a webhook that landed meanwhile is not undone.
    const persistSession = async (existing: PaymentSession, patch: (fresh: PaymentSession) => Partial<PaymentSession>): Promise<PaymentSession> => {
        const fresh = (await store.getPaymentSession(adapter.identifier, existing.id)) ?? existing;
        const merged: PaymentSession = { ...fresh, ...patch(fresh), updatedAt: Date.now() };

        await store.upsertPaymentSession(merged);

        return merged;
    };

    return {
        adapter,

        attach: async (input) => startCheckout({ ...input, mode: input.mode ?? "subscription" }),

        cancelPayment: async (sessionId, cancelOptions) => {
            const existing = await ownedSession(sessionId);

            const key = await outboundKey("cancel_payment", [sessionId], cancelOptions?.idempotencyKey, () => []);
            const updated = await adapter.cancelPayment(sessionId, { ...cancelOptions, idempotencyKey: key });

            // A cancel establishes the state and nothing else — the amounts on the row stand.
            return persistSession(existing, () => {
                return { state: updated.state };
            });
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

            // Already in the requested end state: a retry after a successful cancel. Calling the
            // provider again would be a fresh key (the row's `updatedAt` moved) on a canceled sub.
            const done = cancelOptions?.atPeriodEnd
                ? existing.cancelAtPeriodEnd && (existing.state === "active" || existing.state === "trialing")
                : existing.state === "canceled";

            if (done) {
                return existing;
            }

            // Mode is in the key (period-end and immediate are different calls), and so is `updatedAt`,
            // so cancel → resume → cancel inside the provider's 24h window is a new request.
            const key = await outboundKey("cancel_subscription", [subscriptionId], cancelOptions?.idempotencyKey, () => [
                cancelOptions?.atPeriodEnd ? "period_end" : "now",
                existing.updatedAt,
            ]);
            const synced = overlayProviderSubscription(existing, await adapter.cancelSubscription(subscriptionId, { ...cancelOptions, idempotencyKey: key }));

            await store.upsertSubscription(synced);

            return synced;
        },

        capturePayment: async (input) => {
            const existing = await ownedSession(input.sessionId);

            // The amount is part of the key: `CaptureInput` supports partial captures, and reusing one
            // key across two different amounts makes the provider reject the second call as a
            // parameter mismatch — while two identical ones must still replay rather than double-charge.
            const key = await outboundKey("capture_payment", [input.sessionId], input.idempotencyKey, () => [amountPart(input.amount)]);
            const updated = await adapter.capturePayment({ ...input, idempotencyKey: key });

            // The provider's captured total is authoritative here, and its own `payment.captured`
            // webhook later ASSIGNS the same value (never accumulates), so both paths agree.
            return persistSession(existing, () => {
                return { capturedAmount: updated.capturedAmount, state: updated.state };
            });
        },

        check: async (input) => {
            await ensureAuthorized(input.referenceId);

            // Validate the argument shape BEFORE any delegation, so misuse fails the same way on every
            // provider — otherwise a `check({ referenceId })` with neither `featureId` nor `priceId`
            // would reach a provider-owned adapter unscoped and could fail open ("customer exists").
            if (input.featureId === undefined && input.priceId === undefined) {
                throw new LunoraPaymentError("VALIDATION_ERROR", "check() requires a featureId or priceId");
            }

            const need = requireQuantity("check", input.quantity);

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
                throw new LunoraPaymentError("VALIDATION_ERROR", "check() requires a featureId or priceId");
            }

            if (!options.entitlements) {
                throw new LunoraPaymentError("CONFIG_INVALID", "check() requires `entitlements` to be configured");
            }

            return evaluateFeature(resolveEntitlements(options.entitlements, subscriptions), input.referenceId, input.featureId, need);
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

            const config = options.entitlements;

            if (!config) {
                throw new LunoraPaymentError("CONFIG_INVALID", "listBalances() requires `entitlements` to be configured");
            }

            const subscriptions = await store.listSubscriptionsByReference(referenceId);
            const entitlements = resolveEntitlements(config, subscriptions);
            const names = featureNames(config);
            const metered = names.filter((featureId) => entitlements.limit(featureId) !== undefined);
            // Each metered feature resets on its OWN granting plan's period, so batch the ledger
            // read per distinct window — usually one — rather than one unbounded scan per feature.
            const byWindow = Map.groupBy(metered, (featureId) => entitlements.periodStart(featureId));
            const usage = new Map<string, number>();

            for (const totals of await Promise.all([...byWindow].map(async ([since, featureIds]) => store.sumUsageByFeature(referenceId, featureIds, since)))) {
                for (const [featureId, used] of totals) {
                    usage.set(featureId, used);
                }
            }

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

            // Send the resolved remainder, not "no amount": Polar refunds the whole order total when
            // none is given. Omitted only when the remainder IS the captured total (full-only providers).
            const providerAmount = input.amount ?? (compareMoney(issued, existing.capturedAmount) === 0 ? undefined : issued);

            // Keyed on the amount sent and the reason, so partial refunds don't collide. Two intentional
            // same-amount refunds need distinct caller keys (see `LunoraPayment.refundPayment`).
            const key = await outboundKey("refund_payment", [input.sessionId], input.idempotencyKey, () => [amountPart(providerAmount), input.reason ?? ""]);

            const issuedRefund = await adapter.refundPayment({ ...input, amount: providerAmount, idempotencyKey: key });

            // An unsettled (pending) refund moves no money yet: leave the row and add no marker, so the
            // confirming `payment.refunded` webhook books it (or `refund.failed` leaves nothing to undo).
            if (issuedRefund.pending) {
                return existing;
            }

            // What the provider says this refund moved (Polar caps at the refundable amount and adds
            // tax), else what was asked for. A zero report is "unknown", never "nothing moved": booking it
            // would claim the refund's marker for 0, and the confirming webhook would then add nothing.
            const reported = issuedRefund.refundedAmount;
            const booked = reported.currency === issued.currency && reported.minorUnits > 0n ? reported : issued;
            const marker = localRefundKey(input.sessionId, issuedRefund.refundId, booked);

            // Book the refund on the row now: this ledger is what makes the over-refund guard reject a
            // retry on providers whose refund endpoint takes no key (Polar, Dodo). The marker, keyed on
            // the provider's refund id, stops the confirming delta webhook from counting it twice.
            const freshRefund = await store.markEventProcessed(adapter.identifier, marker, LOCAL_REFUND_CLAIM_TYPE);

            // The marker for this refund id is already claimed: the provider replayed an earlier refund
            // under a colliding key, so no money moved. (An amount-keyed marker proves nothing, so only
            // a provider `refundId` short-circuits.)
            if (!freshRefund && issuedRefund.refundId !== undefined) {
                return existing;
            }

            try {
                // Against the re-read row; an absolute provider's cumulative total may already include this refund.
                return await persistSession(existing, (fresh) => {
                    const prospective =
                        issuedRefund.refundedTotal === undefined
                            ? addMoney(fresh.refundedAmount, booked)
                            : maxMoney(fresh.refundedAmount, issuedRefund.refundedTotal);
                    // The money has already moved, so a total past the capture (two racing refunds
                    // the provider settled between them) is recorded as fully refunded, not thrown.
                    const total = compareMoney(prospective, fresh.capturedAmount) > 0 ? fresh.capturedAmount : prospective;

                    return { refundedAmount: total, state: compareMoney(total, fresh.capturedAmount) < 0 ? "partially_refunded" : "refunded" };
                });
            } catch (error) {
                // The marker is claimed before the row (the webhook may land mid-write) with no transaction
                // across the two, so release it on failure and let the webhook carry the money. A hard
                // isolate kill between the writes still strands it until that webhook consumes it.
                await store.releaseEvent(adapter.identifier, marker);

                throw error;
            }
        },

        store,

        track: async (input) => {
            await ensureAuthorized(input.referenceId);

            const target = requireQuantity("track", input.quantity);

            // A caller key dedupes retries (namespaced, since the ledger's dedupe index is per provider);
            // without one every call records.
            const key = await outboundKey("track", [input.referenceId, input.featureId], input.idempotencyKey, () => [crypto.randomUUID()]);

            // Both modes are one append; the period total is a fold (`foldUsage`) in which "set" resets,
            // so concurrent or replayed sets resolve last-writer-wins without a read-modify-write.
            const isSet = input.mode === "set";

            // A provider meter is additive: a lowering "set" has no delta to forward, so the meter and the
            // local total would drift apart. Reject it wherever a forward would happen.
            if (isSet && adapter.capabilities.usageMetering && adapter.reportUsage) {
                throw new LunoraPaymentError(
                    "VALIDATION_ERROR",
                    `track(): \`mode: "set"\` is not supported on "${adapter.identifier}", whose meter is additive — a lowering set cannot be forwarded, so the provider would over-bill against the local period total. Use \`mode: "add"\`.`,
                );
            }

            // Advisory only — skip a no-op ("set" to the current total, `add 0`); a stale read costs a
            // redundant marker, never a wrong total.
            let current = 0;

            if (isSet) {
                const subscriptions = await store.listSubscriptionsByReference(input.referenceId);
                const since = options.entitlements
                    ? resolveEntitlements(options.entitlements, subscriptions).periodStart(input.featureId)
                    : usagePeriodStart(subscriptions);

                current = await store.sumUsage(input.referenceId, input.featureId, since);
            }

            if (isSet ? target === current : target === 0) {
                return { recorded: false, reportedToProvider: false };
            }

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

            // Only "add" reaches here on a metering provider, so `target` is the delta to forward.
            if (!adapter.capabilities.usageMetering || !adapter.reportUsage) {
                return { recorded: true, reportedToProvider: false };
            }

            try {
                const customer = await store.getCustomerByReference(adapter.identifier, input.referenceId);

                await adapter.reportUsage({
                    customerId: customer?.id,
                    featureId: input.featureId,
                    idempotencyKey: key,
                    quantity: target,
                    referenceId: input.referenceId,
                });
                await store.markUsageReported(adapter.identifier, key);

                return { recorded: true, reportedToProvider: true };
            } catch {
                // Best-effort upstream: the ledger is already written, and `reconcile` retries the forward
                // from `listUnreportedUsage`.
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
