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
import {
    derivedIdempotencyKey,
    heldClaimFor,
    heldClaimWithRefund,
    isHeldClaim,
    LOCAL_REFUND_CLAIM_TYPE,
    localRefundKey,
    PENDING_REFUND_CLAIM_TYPE,
    pendingRefundHeldKey,
    pendingRefundKey,
    refundNeedsPendingGuard,
    UNBOOKED_REFUND_DONE_CLAIM_TYPE,
    UNBOOKED_REFUND_LEASE_MS,
    unbookedRefundClaim,
    unbookedRefundClaimParts,
    unbookedRefundDoneKey,
    unbookedRefundKey,
} from "./idempotency";
import { addMoney, compareMoney, disputedAmountOf, isZeroMoney, maxMoney, subtractMoney, zeroMoney } from "./money";
import type { PaymentObserver } from "./observability";
import { notifyObserver } from "./observability";
import { refundRungKept, SUBSCRIPTION_TERMINAL_STATES } from "./state-machine";
import type { PaymentStore } from "./store";
import { overlayProviderSubscription, ownerOf } from "./store";
import type { SubscriptionWrite } from "./subscription-policy";
import { ENTITLING_STATES, hasOtherLiveSubscription, restoreSubscription, storeSubscription, swapPrimaryPrice } from "./subscription-policy";
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
    PaymentState,
    ProviderCapabilities,
    ProviderId,
    ProviderRefund,
    RefundInput,
    RefundResult,
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

/**
 * How far before a plan change or resume the floor for later webhooks sits. Provider event times come from the provider's
 * clock (Stripe's in whole seconds), so a floor at the call itself would drop a genuine event created just after it, such
 * as the move to past due when the proration charge fails. A redelivered event from before the change is minutes old, so
 * it is still dropped.
 */
const EVENT_FLOOR_MARGIN_MS = 60_000;

/**
 * The row an update or resume answer is recorded as, over `target` (the row under the answer's id).
 *
 * A moved row keeps the history of the row it lands on (its creation date and last event), not the one it left, and the
 * owner the subscription already had. A status read that failed can leave the price set unknown, and a full-row write
 * would then erase the one stored; these operations change only the primary price, so the stored set stands with that
 * price swapped. The seat count is kept the same way, since a mutation answer can omit it (Creem maps missing units to
 * one). An accepted resume clears the period-end cancel even when the status read still reports it (Autumn derives the
 * flag from `canceled_at`, which can trail the uncancel). And a provider event created well before the call describes the
 * row as it was, so a point {@link EVENT_FLOOR_MARGIN_MS} before the call is the floor for the last applied event.
 */
const answerRow = (
    existing: Subscription,
    target: Subscription | undefined,
    answer: { calledAt: number; moved: boolean; readFailed: boolean; setsQuantity: boolean; settled: Subscription; verb: "resumed" | "updated" },
): Subscription => {
    const { calledAt, moved, readFailed, settled } = answer;
    const priceIds =
        !moved && settled.priceIds === undefined && existing.priceIds !== undefined ? swapPrimaryPrice(existing, settled.priceId) : settled.priceIds;
    const quantity = readFailed && !answer.setsQuantity ? existing.quantity : settled.quantity;
    const cancelAtPeriodEnd = answer.verb === "resumed" ? false : settled.cancelAtPeriodEnd;
    const overlaid = overlayProviderSubscription(target, { ...settled, cancelAtPeriodEnd, priceIds, quantity });
    const row: Subscription = { ...overlaid, lastEventAt: Math.max(overlaid.lastEventAt ?? 0, calledAt - EVENT_FLOOR_MARGIN_MS) };

    return moved ? { ...row, referenceId: ownerOf(existing.referenceId, settled.referenceId) } : row;
};

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

/**
 * Whether a refund call failed with a definite answer: the facade's or adapter's own refusal (thrown before
 * any request), or a 4xx the provider sent back (`statusCode` on Polar's SDK errors, `status` on Dodo's).
 * Anything else (a network failure, a timeout, a 5xx) leaves open whether the provider took the refund.
 */
const refundDefinitelyRejected = (error: unknown): boolean => {
    if (error instanceof LunoraPaymentError) {
        return true;
    }

    const { status, statusCode } = (typeof error === "object" && error !== null ? error : {}) as { status?: unknown; statusCode?: unknown };
    const code = statusCode ?? status;

    return typeof code === "number" && code >= 400 && code < 500;
};

/** How often a settlement re-reads and retries a ledger write a concurrent writer beat; each loss means real progress elsewhere. */
const SETTLE_WRITE_ATTEMPTS = 3;

/** The states a settled refund can be booked from, as the refund transition allows. */
const SETTLEABLE_STATES: ReadonlySet<PaymentState> = new Set(["captured", "partially_refunded", "refunded"]);

/** How many of `refunds`, in order, the money `added` covers: the count `refund.hold_released` reports. */
const refundsCovering = (refunds: ReadonlyArray<ProviderRefund>, added: Money): number => {
    let remaining = added;
    let count = 0;

    for (const refund of refunds) {
        if (isZeroMoney(remaining) || remaining.minorUnits < 0n) {
            break;
        }

        count += 1;
        remaining = compareMoney(refund.amount, remaining) >= 0 ? zeroMoney(remaining.currency) : subtractMoney(remaining, refund.amount);
    }

    return count;
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
     * The provider's current state of a subscription, read live. Authorized against the subscription's owner, unknown
     * and not-owner both raise NOT_FOUND. Read-only: the store is not written, so a webhook or `reconcile` is what brings
     * a stored row up to date with this answer.
     */
    getSubscriptionStatus: (subscriptionId: string) => Promise<Subscription>;

    /**
     * Verify + normalize + apply a provider webhook. 200 once verified, even on a no-op — except an
     * event whose target row doesn't exist yet, which returns 500 so the provider redelivers it once.
     */
    handleWebhook: (request: Request) => Promise<Response>;
    /** Resolve every configured feature's allowance for a reference in one call. Requires `entitlements`. */
    listBalances: (referenceId: string) => Promise<FeatureBalance[]>;
    listSubscriptions: (referenceId: string) => Promise<Subscription[]>;

    /**
     * Who the provider is and what it supports, for checks an app makes before it starts an
     * operation (e.g. refusing a checkout that needs session expiry before taking a hold).
     * Read-only data: no operation and no reference to the adapter is reachable from it.
     */
    readonly provider: { readonly capabilities: ProviderCapabilities; readonly identifier: ProviderId };

    /**
     * Refund the caller's own captured payment (authorized, derived idempotency key, store synced).
     *
     * The derived key makes "same session, same amount, same reason" ONE operation for a provider
     * that honours it (Stripe). Two *intentional* refunds of the same amount on one session are
     * therefore indistinguishable from a retry: pass a distinct `RefundInput.idempotencyKey` for the
     * second one, or the provider replays the first and the second moves no money.
     *
     * Polar and Dodo take no key, so the guard there is local: a settled refund is on the ledger and
     * the over-refund check stops its retry, and while a refund is pending the session is locked —
     * any further `refundPayment` on it, retry or a different amount, raises INVALID_TRANSITION
     * before the provider is called, until the `payment.refunded` or `payment.refund_failed`
     * webhook settles it. Nothing else clears the hold on its own: an app that does not receive those
     * webhooks calls {@link LunoraPayment.settlePendingRefund}. A call the provider did not answer (a
     * network failure, a timeout, a 5xx) may have issued the refund, so it keeps the hold too and raises
     * PROVIDER_ERROR saying so; a definite rejection (a 4xx) releases it.
     */
    refundPayment: (input: RefundInput) => Promise<PaymentSession>;

    /**
     * Undo a period-end cancel, or resume a paused subscription (Creem; the others clear `cancelAtPeriodEnd`).
     * Authorized against the subscription's owner, unknown and not-owner both raise NOT_FOUND, and the provider's
     * answer is stored. A resume the single-subscription policy blocks raises INVALID_TRANSITION before the provider
     * is called. A caller-supplied key is claimed before the provider call, and a retry with a key already claimed is
     * refused rather than replayed: the provider's own key window does not cover every provider, and a replayed answer
     * can be stale.
     */
    resumeSubscription: (subscriptionId: string, options?: { idempotencyKey?: string }) => Promise<Subscription>;

    /**
     * A facade over the same provider adapter and store, authorized by `authorize` instead of this facade's rule. For
     * server work with no caller (a deletion job, a queued charge, an org-billing action): the app's `authorize` is the
     * whole check, so it must decide ownership itself. Nothing here widens this facade's own authorization.
     */
    scoped: (authorize: AuthorizeReference) => LunoraPayment;

    /**
     * Clear the hold {@link LunoraPayment.refundPayment} keeps on a Polar or Dodo session while one of its
     * refunds is pending, by asking the provider what became of it — the way out when the refund webhook
     * never arrives. Authorized like `refundPayment` (unknown and not-owner both raise NOT_FOUND).
     *
     * While the provider still reports a refund pending, the hold stays. Otherwise the ledger is raised to the
     * provider's succeeded refund total, never past the captured amount: money the ledger already holds
     * (reconcile writes the provider's total without per-refund markers) is not added again. Every succeeded
     * refund's marker is claimed first, so a late webhook adds nothing, and the hold is released with a
     * `refund.hold_released` observer event; a refund that failed, or none at all, releases it with nothing booked. A session holding nothing is returned as
     * it stands, without asking the provider; so is a session on any other provider, and one whose
     * `refundPayment` call is still waiting on the provider. Returns the stored row.
     */
    settlePendingRefund: (input: { sessionId: string }) => Promise<PaymentSession>;

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

    // An update or resume names an owner that has to be a real one: a row a webhook wrote with no reference is no one's to change.
    const changeableSubscription = async (subscriptionId: string): Promise<Subscription> => {
        const existing = await ownedSubscription(subscriptionId);

        if (existing.referenceId.trim() === "") {
            throw new LunoraPaymentError("NOT_FOUND", `subscription "${subscriptionId}" not found`);
        }

        // A canceled subscription has no way back in the state machine, so it is refused before the provider sees it.
        if (SUBSCRIPTION_TERMINAL_STATES.has(existing.state)) {
            throw new LunoraPaymentError("INVALID_TRANSITION", `subscription "${subscriptionId}" is ${existing.state} and cannot be changed`);
        }

        return existing;
    };

    // A keyed update or resume is claimed before the provider is called, and a claim that is already taken is refused. The
    // attempt that took it may have reached the provider, so the provider is not called again under the same key: Creem and
    // Dodo ignore the key on a proration, so a second call would charge it twice. The claim is kept on failure too, since a
    // rejection cannot be told apart from a lost response here.
    const claimKeyedChange = async (key: string | undefined, type: string, subscriptionId: string): Promise<void> => {
        if (key !== undefined && !(await store.markEventProcessed(adapter.identifier, key, type))) {
            throw new LunoraPaymentError(
                "INVALID_TRANSITION",
                `the change to subscription "${subscriptionId}" was already attempted with this idempotency key and its outcome is unknown; check the subscription and retry with a new key`,
            );
        }
    };

    // Runs the provider call for a claimed key. An adapter raises VALIDATION_ERROR only for a request it refused before
    // sending it (Autumn's seat change, the combined plan-and-seat patch on Creem and Polar), so that outcome is known:
    // nothing changed, and the key is released for a corrected retry. Every other failure keeps the claim.
    const callUnderClaim =
        (key: string | undefined, call: () => Promise<Subscription>): (() => Promise<Subscription>) =>
        async () => {
            try {
                return await call();
            } catch (error) {
                if (key !== undefined && error instanceof LunoraPaymentError && error.code === "VALIDATION_ERROR") {
                    await store.releaseEvent(adapter.identifier, key);
                }

                throw error;
            }
        };

    // Stores the provider's answer to an update or a resume, settled against the provider's current state: the answer is
    // what the provider accepted, and its status read also carries what a webhook changed since. Both calls set absolute
    // state, so a row a webhook moved during the call is not merged onto: the provider has accepted the change and its
    // own event for it follows. The conflict is raised rather than the answer dropped silently. Repeating the call is not
    // safe, since Creem and Dodo charge a proration again, so the caller is sent to reconcile instead.
    // `call` makes the provider request. `sets.quantity` says whether that request changes the seat count.
    const recordSubscriptionAnswer = async (
        existing: Subscription,
        call: () => Promise<Subscription>,
        verb: "updated" | "resumed",
        sets: { quantity: boolean },
    ): Promise<Subscription> => {
        // Any provider event created before the call describes the row as it was, so it must not land on top of the answer.
        const calledAt = Date.now();
        const answer = await call();

        // A provider can move the subscription to a new id (Autumn: a plan change is a new `customer::product` row). The
        // target is guarded by whatever row sits under its id now: absent, or a row from an earlier plan that is replaced.
        // It is read before the provider's state, so a webhook that writes it afterwards makes the guarded write refuse,
        // rather than replace a newer row with an older snapshot.
        const moved = answer.id !== existing.id;
        const target = moved ? await store.getSubscription(adapter.identifier, answer.id) : existing;

        // If the status read fails, the answer the provider accepted is recorded instead: losing a completed change is worse
        // than a stale field that the provider's later event corrects.
        const status = await adapter.getSubscriptionStatus(answer.id).then(
            (settled) => {
                return { readFailed: false, settled };
            },
            () => {
                return { readFailed: true, settled: answer };
            },
        );
        const policy = options.singleSubscriptionPerReference ?? false;
        const conflict = (): LunoraPaymentError =>
            new LunoraPaymentError(
                "INVALID_TRANSITION",
                `the subscription changed while it was being ${verb}; the provider has accepted the change, so reconcile this subscription rather than repeating the change`,
            );

        const synced = answerRow(existing, target, { ...status, calledAt, moved, setsQuantity: sets.quantity, verb });

        // The old row retires first, and only once the new one grants access: a retire that loses a race stops the write
        // there, so both rows never grant at once. A downgrade that leaves the old plan running keeps it active.
        const retires = moved && ENTITLING_STATES.has(synced.state);

        if (retires && !(await store.upsertSubscription({ ...existing, state: "canceled" }, { ifRevision: existing.revision }))) {
            throw conflict();
        }

        // The new row did not land, so the old one goes back to granting access. Only the row this call retired is
        // restored: a revision another write has since moved past is left as that write made it. Nor once anything has
        // written the new row since it was read: that is the provider's own event for the new plan (active, past due, or
        // canceled), and it says what the customer has now, so the old plan stays retired.
        // Says whether a plan still grants access afterwards, as far as this call can tell: the old one restored, or the new one
        // granting because a write made it so.
        const restoreRetired = async (): Promise<boolean> => {
            const current = await store.getSubscription(adapter.identifier, existing.id);
            const destination = await store.getSubscription(adapter.identifier, synced.id);
            const destinationUntouched = destination?.revision === target?.revision && !ENTITLING_STATES.has(destination?.state ?? "canceled");

            if (current?.state === "canceled" && current.revision === (existing.revision ?? 0) + 1 && destinationUntouched) {
                return restoreSubscription(store, policy, current, existing);
            }

            return ENTITLING_STATES.has(destination?.state ?? "canceled");
        };

        // A failed restore leaves the subscription with no plan granting access, and the caller must know that. The message
        // is fixed: storage errors can carry database detail, which `toErrorBody` would echo to the caller. Both failures
        // travel on `cause` for the operator.
        const rollbackFailed = (cause: unknown, restoreError: unknown): LunoraPaymentError =>
            new LunoraPaymentError(
                "INVALID_TRANSITION",
                "the provider's change could not be stored, and the old plan could not be restored; the subscription has no plan granting access, so reconcile it",
                { cause: { restoreError, storeError: cause } },
            );

        let outcome: SubscriptionWrite;

        try {
            outcome = await storeSubscription(store, policy, target, synced, { ifRevision: target?.revision });
        } catch (error) {
            // A failed write after the retire leaves nothing granting access, so the old row is restored before the error goes up.
            // A restore that is skipped leaves no plan granting too, for instance when the policy stepped the new row back
            // after a storage fault, and the caller hears the same: reconcile, not a bare storage error.
            if (retires) {
                const granting = await restoreRetired().catch((restoreError: unknown) => {
                    throw rollbackFailed(error, restoreError);
                });

                if (!granting) {
                    throw rollbackFailed(error, undefined);
                }
            }

            throw error;
        }

        if (outcome === "rejected") {
            if (retires) {
                await restoreRetired().catch((restoreError: unknown) => {
                    throw rollbackFailed(conflict(), restoreError);
                });
            }

            throw conflict();
        }

        if (outcome === "refused") {
            notifyObserver(options.observability, { provider: synced.provider, subscriptionId: synced.id, type: "subscription.duplicate" });
        }

        return (await store.getSubscription(adapter.identifier, synced.id)) ?? synced;
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
    // RE-READ after the provider call, so a webhook that landed meanwhile is not undone, and written guarded on the
    // revision of that read: a webhook landing between the read and the write makes the patch recompute on its row.
    // `owned`, when given, is asked before every attempt: once it answers false, another caller has taken the booking
    // over and the row is returned as it stands.
    const persistSession = async (
        existing: PaymentSession,
        patch: (fresh: PaymentSession) => Partial<PaymentSession>,
        owned?: () => Promise<boolean>,
    ): Promise<PaymentSession> => {
        for (let attempt = 0; attempt < SETTLE_WRITE_ATTEMPTS; attempt += 1) {
            // eslint-disable-next-line no-await-in-loop -- each attempt re-reads the row the last one lost to
            const fresh = (await store.getPaymentSession(adapter.identifier, existing.id)) ?? existing;

            // eslint-disable-next-line no-await-in-loop -- see the read above
            if (owned !== undefined && !(await owned())) {
                return fresh;
            }
            const merged: PaymentSession = { ...fresh, ...patch(fresh), updatedAt: Date.now() };

            // eslint-disable-next-line no-await-in-loop -- see the read above
            if (await store.upsertPaymentSession(merged, { ifRevision: fresh.revision })) {
                return merged;
            }
        }

        throw new LunoraPaymentError("INVALID_TRANSITION", `payment session "${existing.id}" kept changing while it was being written; retry`);
    };

    // Brings the ledger up to the provider's settled refund total. `unrecorded` means money the provider moved
    // did not reach the ledger, which keeps the hold.
    const bookSettledRefunds = async (
        sessionId: string,
        succeeded: ReadonlyArray<ProviderRefund>,
        currency: string,
    ): Promise<{ booked: number; unrecorded: boolean }> => {
        let providerTotal = zeroMoney(currency);

        for (const refund of succeeded) {
            providerTotal = addMoney(providerTotal, refund.amount);
        }

        // Claimed before the ledger moves, so a late webhook for any of them adds nothing even if this call dies
        // between the two; a write that then fails keeps the hold, and the next settlement books the total again.
        for (const refund of succeeded) {
            // eslint-disable-next-line no-await-in-loop -- one marker per refund; nothing to gain from racing them
            await store.markEventProcessed(adapter.identifier, localRefundKey(sessionId, refund.refundId, refund.amount), LOCAL_REFUND_CLAIM_TYPE);
        }

        // The provider's total is absolute, so the ledger becomes the larger of the two rather than gaining a delta:
        // a reconcile that already wrote that total (it books no per-refund markers) is not counted twice. It counts
        // refunds only, so the row's lost disputes are added to it first. The write is guarded on the revision it
        // read, and re-read when a reconcile or a webhook landed in between.
        for (let attempt = 0; attempt < SETTLE_WRITE_ATTEMPTS; attempt += 1) {
            // eslint-disable-next-line no-await-in-loop -- each attempt re-reads the row the last one lost to
            const fresh = await store.getPaymentSession(adapter.identifier, sessionId);

            if (fresh === undefined || !SETTLEABLE_STATES.has(fresh.state)) {
                return { booked: 0, unrecorded: true };
            }

            const reversed = addMoney(providerTotal, disputedAmountOf(fresh));

            if (compareMoney(reversed, fresh.refundedAmount) <= 0) {
                return { booked: 0, unrecorded: false };
            }

            const total = compareMoney(reversed, fresh.capturedAmount) > 0 ? fresh.capturedAmount : reversed;
            const next: PaymentSession = {
                ...fresh,
                refundedAmount: total,
                state: compareMoney(total, fresh.capturedAmount) < 0 ? "partially_refunded" : "refunded",
                updatedAt: Date.now(),
            };

            // eslint-disable-next-line no-await-in-loop -- see the read above
            if (await store.upsertPaymentSession(next, { ifRevision: fresh.revision })) {
                return { booked: refundsCovering(succeeded, subtractMoney(total, fresh.refundedAmount)), unrecorded: false };
            }
        }

        return { booked: 0, unrecorded: true };
    };

    // Books what the provider reports settled on `sessionId`. False while that cannot be recorded yet: a refund still
    // pending, one in another currency, or a ledger write that lost every attempt.
    const bookRefundList = async (sessionId: string, currency: string): Promise<boolean> => {
        const refunds = (await adapter.listRefunds?.(sessionId)) ?? [];
        const succeeded = refunds.filter((refund) => refund.status === "succeeded");

        if (refunds.some((refund) => refund.status === "pending") || succeeded.some((refund) => refund.amount.currency !== currency)) {
            return false;
        }

        const { unrecorded } = await bookSettledRefunds(sessionId, succeeded, currency);

        return !unrecorded;
    };

    // Whether the call holding `claim` can no longer be writing its refund: it said so on its way out, or its lease ran out.
    const unbookedHolderGone = async (sessionId: string, claim: string): Promise<boolean> => {
        const { startedAt, token } = unbookedRefundClaimParts(claim);

        return (
            Date.now() - startedAt >= UNBOOKED_REFUND_LEASE_MS ||
            (await store.getEventClaim(adapter.identifier, unbookedRefundDoneKey(sessionId, token))) !== undefined
        );
    };

    // Books the refund of an earlier unbooked-refund record from the provider's list and lifts the record. True when no
    // record is left; false while its holder may still be writing, or the refund cannot be booked yet. The record is
    // taken over under a lease that has already run out, so if anything below fails, the next call takes it at once;
    // two takeovers at the same time are harmless, as the list books an absolute total.
    const takeUnbookedRefund = async (sessionId: string, token: string, currency: string): Promise<boolean> => {
        const key = unbookedRefundKey(sessionId);
        const earlier = await store.getEventClaim(adapter.identifier, key);

        if (earlier === undefined) {
            return true;
        }

        if (!(await unbookedHolderGone(sessionId, earlier))) {
            return false;
        }

        const takeover = unbookedRefundClaim(token, 0);

        await store.releaseEvent(adapter.identifier, key, earlier);

        if (!(await store.markEventProcessed(adapter.identifier, key, takeover)) || !(await bookRefundList(sessionId, currency))) {
            return false;
        }

        await store.releaseEvent(adapter.identifier, key, takeover);

        return true;
    };

    // Books an unbooked-refund record's refund from the provider's list once its holder has ended.
    const settleUnbookedRefund = async (existing: PaymentSession): Promise<PaymentSession> => {
        await takeUnbookedRefund(existing.id, crypto.randomUUID(), existing.refundedAmount.currency);

        return (await store.getPaymentSession(adapter.identifier, existing.id)) ?? existing;
    };

    // Clears an earlier unbooked refund and claims this call's record. False when either cannot be done yet.
    const claimUnbookedRecord = async (sessionId: string, unbookedClaim: string, currency: string): Promise<boolean> =>
        (await takeUnbookedRefund(sessionId, unbookedRefundClaimParts(unbookedClaim).token, currency)) &&
        store.markEventProcessed(adapter.identifier, unbookedRefundKey(sessionId), unbookedClaim);

    // Claims refundPayment's pending-refund marker, or refuses while another call holds it, and returns the row as it
    // stands once claimed. The over-refund check read the row before the claim: a refund booked, and its marker released,
    // in between is on the ledger now, and an unkeyed refund must not be issued on top of it, so an explicit amount is
    // checked again once claimed and the claim given back on refusal. A full refund is resized by the caller instead.
    const claimPendingRefund = async (
        existing: PaymentSession,
        pendingClaim: string,
        requested: Money | undefined,
        unbookedClaim: string | undefined,
    ): Promise<PaymentSession> => {
        if (!(await store.markEventProcessed(adapter.identifier, pendingRefundKey(existing.id), pendingClaim))) {
            throw new LunoraPaymentError("INVALID_TRANSITION", "a refund on this session is still pending; retry once it settles");
        }

        // An earlier refund the provider may have issued and no ledger write took is booked first, or blocks this one. This
        // call's own claim goes back on every way out, a throw included, or nothing would ever release it.
        let clear: boolean;

        try {
            clear = unbookedClaim === undefined || (await claimUnbookedRecord(existing.id, unbookedClaim, existing.refundedAmount.currency));
        } catch (error) {
            await store.releaseEvent(adapter.identifier, pendingRefundKey(existing.id), pendingClaim);

            throw error;
        }

        if (!clear) {
            await store.releaseEvent(adapter.identifier, pendingRefundKey(existing.id), pendingClaim);

            throw new LunoraPaymentError("INVALID_TRANSITION", "an earlier refund on this session is not on the ledger yet; retry once it settles");
        }

        const current = (await store.getPaymentSession(adapter.identifier, existing.id)) ?? existing;

        if (requested !== undefined && compareMoney(addMoney(current.refundedAmount, requested), current.capturedAmount) > 0) {
            await store.releaseEvent(adapter.identifier, pendingRefundKey(existing.id), pendingClaim);

            if (unbookedClaim !== undefined) {
                await store.releaseEvent(adapter.identifier, unbookedRefundKey(existing.id), unbookedClaim);
            }

            throw new LunoraPaymentError(
                "VALIDATION_ERROR",
                `refundPayment(): refunding ${String(requested.minorUnits)} would exceed the captured amount on session "${existing.id}"`,
            );
        }

        return current;
    };

    // Marks a refundPayment call's pending-refund marker as held, which is what lets settlePendingRefund release it.
    const holdPendingRefund = async (sessionId: string, pendingClaim: string, refundId?: string): Promise<void> => {
        const heldMarker = pendingRefundHeldKey(sessionId);
        const heldClaim = heldClaimWithRefund(heldClaimFor(pendingClaim), refundId);

        // A webhook that settled the refund during the call released the marker already; nothing is left to hold.
        if ((await store.getEventClaim(adapter.identifier, pendingRefundKey(sessionId))) !== pendingClaim) {
            return;
        }

        // Only the marker's owner writes the held marker, so one already there is stale: written by an earlier
        // call after the webhook that settled its refund had cleared both. Unless the marker changed hands since the
        // check above, in which case the hold there is its new owner's and this call has nothing left to hold.
        if (!(await store.markEventProcessed(adapter.identifier, heldMarker, heldClaim))) {
            if ((await store.getEventClaim(adapter.identifier, pendingRefundKey(sessionId))) !== pendingClaim) {
                return;
            }

            const stale = await store.getEventClaim(adapter.identifier, heldMarker);

            if (stale !== undefined) {
                await store.releaseEvent(adapter.identifier, heldMarker, stale);
            }

            await store.markEventProcessed(adapter.identifier, heldMarker, heldClaim);
        }
    };

    // For a refund the provider issued that the ledger write did not record, on a provider whose refunds cannot be
    // listed. The marker is claimed before the row (the webhook may land mid-write) with no transaction across the
    // two, so it is released and the webhook carries the money; a hard isolate kill between the writes still strands
    // it until that webhook consumes it. An unkeyed provider would issue a retry again, so the session stays held as
    // for a pending refund until its webhook books it.
    const leaveRefundToWebhook = async (sessionId: string, marker: string, pendingClaim: string, refundId: string | undefined): Promise<void> => {
        await store.releaseEvent(adapter.identifier, marker);

        if (refundNeedsPendingGuard(adapter.identifier)) {
            await holdPendingRefund(sessionId, pendingClaim, refundId);
        }
    };

    const releaseUnbookedRefund = async (sessionId: string, unbookedClaim: string | undefined): Promise<void> => {
        if (unbookedClaim !== undefined) {
            await store.releaseEvent(adapter.identifier, unbookedRefundKey(sessionId), unbookedClaim);
        }
    };

    // Says a refund call that may have left its refund off the ledger has ended, so the next call need not wait out the
    // lease. Best effort: should it fail, the lease frees the record, and the call's own error is the one its caller sees.
    const markUnbookedRefundEnded = async (sessionId: string, unbookedClaim: string | undefined): Promise<void> => {
        if (unbookedClaim !== undefined) {
            const { token } = unbookedRefundClaimParts(unbookedClaim);

            await store.markEventProcessed(adapter.identifier, unbookedRefundDoneKey(sessionId, token), UNBOOKED_REFUND_DONE_CLAIM_TYPE).catch(() => false);
        }
    };

    // Books a refund the provider settled onto the row, and answers the row as it then stands.
    const bookIssuedRefund = async (
        input: RefundInput,
        existing: PaymentSession,
        issued: Money,
        issuedRefund: RefundResult,
        pendingClaim: string,
        unbookedClaim: string | undefined,
    ): Promise<PaymentSession> => {
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
        // a provider `refundId` short-circuits.) The caller asked for a refund that never happened,
        // so the observer is told; the return value stays the row as it stands.
        if (!freshRefund && issuedRefund.refundId !== undefined) {
            // The confirming webhook claims the same marker, and can land while the refund call is in
            // flight. Its booking shows as a refunded total that grew since the read above; an earlier
            // facade call's booking is already in that read, so only a replay leaves the total unchanged.
            const current = (await store.getPaymentSession(adapter.identifier, existing.id)) ?? existing;

            if (compareMoney(current.refundedAmount, existing.refundedAmount) > 0) {
                return current;
            }

            notifyObserver(options.observability, {
                provider: adapter.identifier,
                referenceId: existing.referenceId,
                refundId: issuedRefund.refundId,
                sessionId: input.sessionId,
                type: "refund.replayed",
            });

            return existing;
        }

        // Asked before every attempt: a later call that took the unbooked-refund record over books this refund from
        // the provider's list, so this call's delta must not land as well.
        const owned =
            unbookedClaim === undefined
                ? undefined
                : async (): Promise<boolean> => (await store.getEventClaim(adapter.identifier, unbookedRefundKey(input.sessionId))) === unbookedClaim;

        try {
            // Against the re-read row; an absolute provider's cumulative total may already include this refund,
            // and counts no lost dispute, so the row's are added to it.
            return await persistSession(
                existing,
                (fresh) => {
                    const prospective =
                        issuedRefund.refundedTotal === undefined
                            ? addMoney(fresh.refundedAmount, booked)
                            : maxMoney(fresh.refundedAmount, addMoney(issuedRefund.refundedTotal, disputedAmountOf(fresh)));
                    // The money has already moved, so a total past the capture (two racing refunds
                    // the provider settled between them) is recorded as fully refunded, not thrown.
                    const total = compareMoney(prospective, fresh.capturedAmount) > 0 ? fresh.capturedAmount : prospective;

                    return { refundedAmount: total, state: compareMoney(total, fresh.capturedAmount) < 0 ? "partially_refunded" : "refunded" };
                },
                owned,
            );
        } catch (error) {
            // With an unbooked-refund record the marker stays claimed and the record stays standing: the provider's
            // list books this refund later, so a webhook acknowledged as a duplicate meanwhile loses nothing.
            if (unbookedClaim === undefined) {
                await leaveRefundToWebhook(input.sessionId, marker, pendingClaim, issuedRefund.refundId);
            }

            throw error;
        }
    };

    // Copies, not the adapter's own objects: nothing reachable from `provider` can call an operation or change
    // what the facade reads from the adapter.
    const provider = Object.freeze({
        capabilities: Object.freeze({
            ...(adapter.capabilities.checkoutExpiry === undefined ? {} : { checkoutExpiry: adapter.capabilities.checkoutExpiry }),
            merchantOfRecord: adapter.capabilities.merchantOfRecord,
            portal: adapter.capabilities.portal,
            usageMetering: adapter.capabilities.usageMetering,
        }),
        identifier: adapter.identifier,
    });

    return {
        attach: async (input) => startCheckout({ ...input, mode: input.mode ?? "subscription" }),

        scoped: (authorize) => createPayment({ ...options, authorize }),

        cancelPayment: async (sessionId, cancelOptions) => {
            const existing = await ownedSession(sessionId);

            const key = await outboundKey("cancel_payment", [sessionId], cancelOptions?.idempotencyKey, () => []);
            const updated = await adapter.cancelPayment(sessionId, { ...cancelOptions, idempotencyKey: key });

            // A cancel establishes the state and nothing else — the amounts on the row stand, and so does a
            // refund rung a webhook booked since the call.
            return persistSession(existing, (fresh) => {
                return { state: refundRungKept(fresh.state, updated.state) };
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

        getSubscriptionStatus: async (subscriptionId) => {
            // A status read is not an event, so the owner and the event clock stay as the store has them.
            const existing = await ownedSubscription(subscriptionId);

            return overlayProviderSubscription(existing, await adapter.getSubscriptionStatus(subscriptionId));
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
            // A refund booked since the call keeps its rung: the capture does not undo it.
            return persistSession(existing, (fresh) => {
                return { capturedAmount: updated.capturedAmount, state: refundRungKept(fresh.state, updated.state) };
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

        provider,

        resumeSubscription: async (subscriptionId, resumeOptions) => {
            const existing = await changeableSubscription(subscriptionId);

            // A resume that would start granting access while another subscription already does is refused before the provider
            // is called, so the provider does not bill for a subscription the policy will not grant. A row that already grants
            // access (an undone period-end cancel) adds nothing, so it is not refused.
            if (
                (options.singleSubscriptionPerReference ?? false) &&
                !ENTITLING_STATES.has(existing.state) &&
                (await hasOtherLiveSubscription(store, existing.referenceId, existing.provider, existing.id))
            ) {
                notifyObserver(options.observability, { provider: existing.provider, subscriptionId: existing.id, type: "subscription.duplicate" });

                throw new LunoraPaymentError(
                    "INVALID_TRANSITION",
                    "the single-subscription policy refuses this resume: another subscription for this reference already grants access",
                );
            }

            // A caller-supplied key is derived here, then claimed before the provider call (see claimKeyedChange).
            const key =
                resumeOptions?.idempotencyKey === undefined
                    ? undefined
                    : await derivedIdempotencyKey("resume_subscription", adapter.identifier, subscriptionId, resumeOptions.idempotencyKey);

            await claimKeyedChange(key, "marker.resume_subscription", subscriptionId);

            return recordSubscriptionAnswer(
                existing,
                callUnderClaim(key, () => adapter.resumeSubscription(subscriptionId, { idempotencyKey: key })),
                "resumed",
                {
                    quantity: false,
                },
            );
        },

        refundPayment: async (input) => {
            const read = await ownedSession(input.sessionId);

            // Resolve the resulting refunded total BEFORE moving money: a mismatched currency or an
            // over-refund must fail with nothing issued, not leave a refund the ledger can't record.
            // A full refund issues whatever is left unrefunded, which is also the amount the provider
            // will report on the confirming webhook.
            const remainderOf = (session: PaymentSession): Money => input.amount ?? subtractMoney(session.capturedAmount, session.refundedAmount);
            const firstIssued = remainderOf(read);
            const refunded = addMoney(read.refundedAmount, firstIssued);

            if (compareMoney(refunded, read.capturedAmount) > 0) {
                throw new LunoraPaymentError(
                    "VALIDATION_ERROR",
                    `refundPayment(): refunding ${String(input.amount?.minorUnits)} would exceed the captured amount on session "${input.sessionId}"`,
                );
            }

            // Nothing left to refund — the ledger already holds the whole captured amount. Return the
            // row as it stands instead of asking the provider to move zero (Polar would read the order
            // total and refund it a second time; the guard above cannot catch that, because `issued` is
            // zero and the total does not move).
            if (isZeroMoney(firstIssued)) {
                return read;
            }

            // Polar and Dodo refunds carry no key, and a pending refund is not on the ledger, so nothing
            // else stops a retry from issuing it again. Claimed before the provider call: the confirming
            // webhook can land while the call is in flight, and would find no marker to release.
            const pendingGuarded = refundNeedsPendingGuard(adapter.identifier);
            const pendingMarker = pendingRefundKey(input.sessionId);
            // The claim names this call: a webhook can release the marker while the call is in flight and a
            // newer call re-claim it, and only the newer call may then release it.
            const pendingClaim = `${PENDING_REFUND_CLAIM_TYPE}:${crypto.randomUUID()}`;
            // Only a provider that can list its refunds can book one from that list later; see `unbookedRefundKey`.
            const unbookedClaim = pendingGuarded && adapter.listRefunds !== undefined ? unbookedRefundClaim(crypto.randomUUID(), Date.now()) : undefined;
            // A full refund is the remainder of the row as claimed: a refund booked since the first read shrinks it.
            const existing = pendingGuarded ? await claimPendingRefund(read, pendingClaim, input.amount, unbookedClaim) : read;
            const issued = remainderOf(existing);
            // Set while a refund of this call may be off the ledger: from the provider call until its answer is refused,
            // pending, or booked. The record is lifted on every other way out.
            let mayBeUnbooked = false;

            if (isZeroMoney(issued)) {
                await store.releaseEvent(adapter.identifier, pendingMarker, pendingClaim);
                await releaseUnbookedRefund(input.sessionId, unbookedClaim);

                return existing;
            }

            // Send the resolved remainder, not "no amount": Polar refunds the whole order total when
            // none is given. Omitted only when the remainder IS the captured total (full-only providers).
            const providerAmount = input.amount ?? (compareMoney(issued, existing.capturedAmount) === 0 ? undefined : issued);

            try {
                // Keyed on the amount sent and the reason, so partial refunds don't collide. Two intentional
                // same-amount refunds need distinct caller keys (see `LunoraPayment.refundPayment`).
                const key = await outboundKey("refund_payment", [input.sessionId], input.idempotencyKey, () => [
                    amountPart(providerAmount),
                    input.reason ?? "",
                ]);

                mayBeUnbooked = true;

                const issuedRefund = await adapter.refundPayment({ ...input, amount: providerAmount, idempotencyKey: key }).catch(async (error: unknown) => {
                    if (!pendingGuarded || refundDefinitelyRejected(error)) {
                        mayBeUnbooked = false;

                        throw error;
                    }

                    // No answer: the provider may have taken the refund, and its call carries no key, so a retry
                    // could issue it twice. Hold the session as for a pending answer.
                    await holdPendingRefund(input.sessionId, pendingClaim);

                    throw new LunoraPaymentError(
                        "PROVIDER_ERROR",
                        "refundPayment(): the provider did not answer, so the refund may have been issued; the session stays held until its refund webhook arrives or settlePendingRefund reads what the provider did",
                        { cause: error },
                    );
                });

                // An unsettled (pending) refund moves no money yet: leave the row and add no refund marker, so
                // the confirming `payment.refunded` webhook books it (or `payment.refund_failed` leaves
                // nothing to undo). The pending marker stays until one of those two, or settlePendingRefund, settles it.
                if (issuedRefund.pending) {
                    await holdPendingRefund(input.sessionId, pendingClaim, issuedRefund.refundId);
                    mayBeUnbooked = false;

                    return existing;
                }

                const recorded = await bookIssuedRefund(input, existing, issued, issuedRefund, pendingClaim, unbookedClaim);

                mayBeUnbooked = false;

                return recorded;
            } finally {
                // A settled refund is on the ledger by now, and a rejected call is retried as before; a held one
                // stays held. Only this call's own claim is released: the marker may be a newer call's by now.
                if (
                    pendingGuarded &&
                    !isHeldClaim(await store.getEventClaim(adapter.identifier, pendingRefundHeldKey(input.sessionId)), heldClaimFor(pendingClaim))
                ) {
                    await store.releaseEvent(adapter.identifier, pendingMarker, pendingClaim);
                }

                await (mayBeUnbooked ? markUnbookedRefundEnded(input.sessionId, unbookedClaim) : releaseUnbookedRefund(input.sessionId, unbookedClaim));
            }
        },

        settlePendingRefund: async ({ sessionId }) => {
            const existing = await ownedSession(sessionId);

            if (!refundNeedsPendingGuard(adapter.identifier)) {
                return existing;
            }

            const { listRefunds } = adapter;

            if (listRefunds === undefined) {
                throw new LunoraPaymentError("CONFIG_INVALID", `settlePendingRefund(): the ${adapter.identifier} adapter cannot list a payment's refunds`);
            }

            const marker = pendingRefundKey(sessionId);
            const heldMarker = pendingRefundHeldKey(sessionId);
            const pendingClaim = await store.getEventClaim(adapter.identifier, marker);

            // No call in flight: an earlier refund the provider may have issued and no ledger write took is booked from
            // the provider's list. While a call holds the marker, its own record is that call's to settle.
            if (pendingClaim === undefined) {
                return settleUnbookedRefund(existing);
            }

            const heldClaim = await store.getEventClaim(adapter.identifier, heldMarker);

            // A marker not yet held belongs to a refundPayment call still waiting on the provider: what the
            // provider reports now says nothing about that call's refund, and releasing it would let a second
            // refund start beside it.
            if (heldClaim === undefined || !isHeldClaim(heldClaim, heldClaimFor(pendingClaim))) {
                return existing;
            }

            const refunds = await listRefunds(sessionId);

            // Booking a settled sibling would release the hold (the webhook path does) while this refund can still move money.
            if (refunds.some((refund) => refund.status === "pending")) {
                return existing;
            }

            const succeeded = refunds.filter((refund) => refund.status === "succeeded");
            const { currency } = existing.refundedAmount;

            // A refund in another currency cannot be measured against the ledger, nor booked on it.
            if (succeeded.some((refund) => refund.amount.currency !== currency)) {
                return existing;
            }

            const { booked, unrecorded } = await bookSettledRefunds(sessionId, succeeded, currency);

            // Money the provider moved and the ledger could not take keeps the hold, so the next refund
            // cannot be issued against a total that is short.
            if (unrecorded) {
                return (await store.getPaymentSession(adapter.identifier, sessionId)) ?? existing;
            }

            await store.releaseEvent(adapter.identifier, marker, pendingClaim);
            await store.releaseEvent(adapter.identifier, heldMarker, heldClaim);
            notifyObserver(options.observability, {
                booked,
                provider: adapter.identifier,
                referenceId: existing.referenceId,
                sessionId,
                type: "refund.hold_released",
            });

            return (await store.getPaymentSession(adapter.identifier, sessionId)) ?? existing;
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
            const existing = await changeableSubscription(subscriptionId);

            // Validated here so every provider refuses a bad seat count before its own call. A missing quantity is
            // not defaulted: requireQuantity's default of 1 would turn "leave the seats alone" into a seat cut.
            // Zero seats would keep the plan running with nobody on it, so ending a subscription is cancelSubscription's job.
            if (patch.quantity !== undefined) {
                requireQuantity("updateSubscription", patch.quantity);

                if (patch.quantity < 1) {
                    throw new LunoraPaymentError("VALIDATION_ERROR", "updateSubscription(): `quantity` must be at least 1; cancel the subscription to end it");
                }
            }

            if (patch.priceId?.trim() === "") {
                throw new LunoraPaymentError("VALIDATION_ERROR", "updateSubscription(): `priceId` must name a plan");
            }

            const key =
                patch.idempotencyKey === undefined
                    ? undefined
                    : await derivedIdempotencyKey("update_subscription", adapter.identifier, subscriptionId, patch.idempotencyKey);

            await claimKeyedChange(key, "marker.update_subscription", subscriptionId);

            return recordSubscriptionAnswer(
                existing,
                callUnderClaim(key, () => adapter.updateSubscription(subscriptionId, { ...patch, idempotencyKey: key })),
                "updated",
                {
                    quantity: patch.quantity !== undefined,
                },
            );
        },
    };
};
