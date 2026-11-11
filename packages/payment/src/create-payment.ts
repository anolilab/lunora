/**
 * The payment facade.
 *
 * Wraps an adapter + store with the cross-cutting guarantees every call needs: per-caller
 * authorization (no IDOR), outbound idempotency keys (no double-charge), and webhook ingestion
 * that verifies, normalizes, and applies through the FSM.
 */
import { LunoraError, toErrorBody } from "@lunora/errors";

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
import type { SubscriptionWrite } from "./subscription-policy";
import { storeSubscription } from "./subscription-policy";
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
    ProviderId,
    RefundInput,
    Subscription,
    SubscriptionPatch,
    TrackInput,
    TrackResult,
} from "./types";
import { readWebhookBody } from "./webhook-body";

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

/** How many guarded writes record a cancel answer over a row that keeps moving under it, before the conflict is raised. */
const CANCEL_RECORD_ATTEMPTS = 3;

/**
 * Record the provider's cancel answer over `current`, the row as it stands now. The lifecycle state of a row a webhook
 * moved stands, and the cancellation is recorded on top of it. Every write is guarded, so no webhook's state is ever
 * overwritten. A write that loses a race re-reads the row and tries again; when every attempt loses, the conflict is
 * raised rather than the cancel dropped silently. Reconciliation then records the provider's state for that row.
 */
const recordCancelAnswer = async (
    store: PaymentStore,
    policy: boolean,
    synced: Subscription,
    current: Subscription,
    attempts: number,
): Promise<SubscriptionWrite> => {
    const merged: Subscription = {
        ...current,
        cancelAtPeriodEnd: synced.cancelAtPeriodEnd,
        state: synced.state === "canceled" ? "canceled" : current.state,
        updatedAt: Date.now(),
    };
    const outcome = await storeSubscription(store, policy, current, merged, { ifRevision: current.revision });

    if (outcome !== "rejected") {
        return outcome;
    }

    if (attempts <= 1) {
        throw new LunoraPaymentError(
            "INVALID_TRANSITION",
            "the subscription changed while it was being cancelled; the provider has accepted the cancel, so reconcile this subscription",
        );
    }

    const latest = (await store.getSubscription(current.provider, current.id)) ?? current;

    return recordCancelAnswer(store, policy, synced, latest, attempts - 1);
};

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

    /**
     * The reference a verified subscription event concerns (applied, duplicate or stale alike),
     * from the stored subscription — what an app re-derives plan-dependent state for, idempotently.
     * Never sent back to the provider: {@link webhookResponse} answers with `applied` only.
     */
    referenceId?: string;
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
     * Per-caller authorization for every mutation. Return `true` to allow; anything else
     * (including a throw) rejects with 403. Required — there is no default-open mode.
     */
    readonly authorize: AuthorizeReference;
    /** Plan → features/limits map. Required for `check`; omit if you don't gate features. */
    readonly entitlements?: EntitlementsConfig;
    /** Optional telemetry sink — fired on webhook apply, failed payments, and past-due subscriptions. */
    readonly observability?: PaymentObserver;

    /**
     * Refuse a second subscription that grants access on one reference. Off by default: some apps sell several
     * subscriptions per customer. When on, a write that would give a second subscription access is refused. The
     * refused subscription is recorded in a non-granting state, so it can be cancelled in the app, and `subscription.duplicate`
     * tells the operator to cancel it at the provider, which still bills it. A paused or past-due subscription grants
     * nothing, so it does not count.
     */
    readonly singleSubscriptionPerReference?: boolean;
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

    /**
     * Undo a period-end cancel, or resume a paused subscription (Creem; the others clear `cancelAtPeriodEnd`).
     * Authorized against the subscription's owner, unknown and not-owner both raise NOT_FOUND, and the provider's
     * answer is stored. Only a caller-supplied key is forwarded: the change is absolute, so a derived key would
     * replay a stale answer if the subscription is cancelled and resumed again inside the provider's key window.
     */
    resumeSubscription: (subscriptionId: string, options?: { idempotencyKey?: string }) => Promise<Subscription>;
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

    /**
     * Change the plan (`priceId`) or seats (`quantity`) of the caller's own subscription. Authorized against the
     * subscription's owner, unknown and not-owner both raise NOT_FOUND, and the provider's answer is stored. Only a
     * caller-supplied key is forwarded, for the reason given on {@link SubscriptionPatch.idempotencyKey}.
     */
    updateSubscription: (subscriptionId: string, patch: SubscriptionPatch) => Promise<Subscription>;
}

export const createPayment = (options: CreatePaymentOptions): LunoraPayment => {
    const { adapter, store } = options;

    // Untyped JavaScript can omit `authorize`. Fail at construction rather than per call, so the
    // misconfiguration surfaces where it is written and no mutation ever reaches the provider.
    if (typeof options.authorize !== "function") {
        throw new LunoraPaymentError("CONFIG_INVALID", "createPayment(): `authorize` must be a function (per-caller authorization is required)");
    }

    /**
     * The reference a subscription event concerns, read from the stored subscription after the
     * event is applied, so it follows the owner the merge kept rather than whatever the event
     * named. The event's own reference only stands in when nothing was stored.
     */
    const subscriptionReference = async (provider: ProviderId, subscriptionId: string, named: string | undefined): Promise<string | undefined> => {
        const stored = await store.getSubscription(provider, subscriptionId);

        if (stored !== undefined && stored.referenceId.trim() !== "") {
            return stored.referenceId;
        }

        return named !== undefined && named.trim() !== "" ? named.trim() : undefined;
    };

    const ensureAuthorized = async (referenceId: string): Promise<void> => {
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

        if (input.expiresAt !== undefined && !adapter.capabilities.checkoutExpiry) {
            throw new LunoraPaymentError("PROVIDER_ERROR", `${adapter.identifier} does not support checkout expiry`);
        }

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
            // Only when set, so a checkout without one keeps the key it always had.
            ...(input.expiresAt === undefined ? [] : [String(input.expiresAt)]),
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

    // Shared ownership guard for the subscription operations. Collapse "doesn't exist" and "not yours"
    // into one indistinguishable NOT_FOUND so the endpoint can't be used as a cross-tenant existence
    // oracle. A non-owner authorizer denial is rewritten to the same 404 as a genuinely missing id.
    const ownedSubscription = async (subscriptionId: string): Promise<Subscription> => {
        const notFound = (): LunoraPaymentError => new LunoraPaymentError("NOT_FOUND", `subscription "${subscriptionId}" not found`);
        const existing = await store.getSubscription(adapter.identifier, subscriptionId);

        if (!existing) {
            throw notFound();
        }

        try {
            await ensureAuthorized(existing.referenceId);
        } catch {
            throw notFound();
        }

        return existing;
    };

    // Stores the provider's answer to an update or a resume. Both calls set absolute state, so a row a
    // webhook moved during the call is not merged onto: the provider has accepted the change and its own
    // event for it follows. The conflict is raised rather than the answer dropped silently, and a retry is
    // safe for the same reason.
    const recordSubscriptionAnswer = async (existing: Subscription, answer: Subscription, verb: "updated" | "resumed"): Promise<Subscription> => {
        const synced = overlayProviderSubscription(existing, answer);
        const policy = options.singleSubscriptionPerReference ?? false;
        const outcome = await storeSubscription(store, policy, existing, synced, { ifRevision: existing.revision });

        if (outcome === "rejected") {
            throw new LunoraPaymentError(
                "INVALID_TRANSITION",
                `the subscription changed while it was being ${verb}; the provider has accepted the change, so retry or reconcile this subscription`,
            );
        }

        if (outcome === "refused") {
            notifyObserver(options.observability, { provider: synced.provider, subscriptionId: synced.id, type: "subscription.duplicate" });
        }

        return (await store.getSubscription(adapter.identifier, existing.id)) ?? synced;
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
            const existing = await ownedSubscription(subscriptionId);

            // Already in the requested end state: a retry after a successful cancel. Calling the
            // provider again would be a fresh key (the row's `updatedAt` moved) on a canceled sub.
            const done = cancelOptions?.atPeriodEnd ? existing.cancelAtPeriodEnd && existing.state !== "canceled" : existing.state === "canceled";

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

            // The provider's answer goes through the policy, so a second live subscription is refused rather than
            // granted. It is guarded by the revision read before the call. If a webhook landed during the call, that
            // webhook's lifecycle state stands, and the cancellation itself is recorded on top of it: a cancel is never
            // dropped because the row moved.
            const policy = options.singleSubscriptionPerReference ?? false;
            let outcome = await storeSubscription(store, policy, existing, synced, { ifRevision: existing.revision });

            if (outcome === "rejected") {
                const current = (await store.getSubscription(adapter.identifier, subscriptionId)) ?? existing;

                outcome = await recordCancelAnswer(store, policy, synced, current, CANCEL_RECORD_ATTEMPTS);
            }

            if (outcome === "refused") {
                notifyObserver(options.observability, { provider: synced.provider, subscriptionId: synced.id, type: "subscription.duplicate" });
            }

            // Whatever the store now holds is what the caller gets, so a refused or merged cancel is reported as stored.
            return (await store.getSubscription(adapter.identifier, subscriptionId)) ?? synced;
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

            return adapter.createPortalSession({ customerId: customer.id, referenceId, returnUrl });
        },

        handleWebhook: async (request) => {
            let action;

            try {
                const payload = await readWebhookBody(request);

                action = await adapter.parseWebhook({ headers: request.headers, payload });
            } catch (error) {
                if (error instanceof LunoraError && error.code === "PAYLOAD_TOO_LARGE") {
                    return jsonResponse({ error: "webhook body too large" }, 413);
                }

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
            const result = await applyWebhookAction(store, action, options.observability, options.singleSubscriptionPerReference ?? false);

            // Deliberate non-200: the row this event patches hasn't been created yet (out-of-order
            // delivery), and its claim was released — the provider must retry so the update applies
            // once the create event lands. Only `orphaned` gets this; genuinely unhandleable events
            // keep the always-200 contract below.
            if (result.reason === "orphaned") {
                return jsonResponse({ applied: result.applied, reason: result.reason }, 500);
            }

            // Every other outcome acknowledges: once verified, a no-op is still a 200 and the provider
            // stops retrying. A subscription event names the reference it concerns, so the app can
            // refresh what it derives from that reference's plan. A duplicate or stale one does
            // too: when the app's refresh failed and the route answered 5xx, the provider's retry
            // arrives as a duplicate, and is the app's chance to finish it.
            const referenceId =
                action.subscriptionId === undefined ? undefined : await subscriptionReference(action.provider, action.subscriptionId, action.referenceId);

            return jsonResponse({ applied: result.applied, reason: result.reason, ...(referenceId === undefined ? {} : { referenceId }) }, 200);
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

        resumeSubscription: async (subscriptionId, resumeOptions) => {
            const existing = await ownedSubscription(subscriptionId);
            // `undefined` is forwarded as-is, not derived: see the interface comment on why a derived key is wrong here.
            const key =
                resumeOptions?.idempotencyKey === undefined
                    ? undefined
                    : await outboundKey("resume_subscription", [subscriptionId], resumeOptions.idempotencyKey, () => []);

            return recordSubscriptionAnswer(existing, await adapter.resumeSubscription(subscriptionId, { idempotencyKey: key }), "resumed");
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

        updateSubscription: async (subscriptionId, patch) => {
            const existing = await ownedSubscription(subscriptionId);

            // Validated here so every provider refuses a bad seat count before its own call. A missing quantity is
            // not defaulted: requireQuantity's default of 1 would turn "leave the seats alone" into a seat cut.
            if (patch.quantity !== undefined) {
                requireQuantity("updateSubscription", patch.quantity);
            }

            const key =
                patch.idempotencyKey === undefined ? undefined : await outboundKey("update_subscription", [subscriptionId], patch.idempotencyKey, () => []);

            return recordSubscriptionAnswer(existing, await adapter.updateSubscription(subscriptionId, { ...patch, idempotencyKey: key }), "updated");
        },
    };
};
