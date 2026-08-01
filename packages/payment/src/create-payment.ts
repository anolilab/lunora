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
import { derivedIdempotencyKey, idempotencyKey } from "./idempotency";
import type { PaymentObserver } from "./observability";
import { notifyObserver } from "./observability";
import type { PaymentStore } from "./store";
import applyWebhookAction from "./sync";
import type {
    AttachInput,
    CancelSubscriptionOptions,
    CheckInput,
    CheckoutInput,
    CheckoutResult,
    CheckResult,
    FeatureBalance,
    Subscription,
    TrackInput,
    TrackResult,
} from "./types";

/** Drop a caller-supplied `referenceId` from checkout metadata — it's framework-controlled, never caller-set. */
const stripReferenceId = (metadata: Record<string, string> | undefined): Record<string, string> | undefined =>
    metadata && "referenceId" in metadata ? Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== "referenceId")) : metadata;

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
    cancelSubscription: (subscriptionId: string, options?: CancelSubscriptionOptions) => Promise<Subscription>;

    /**
     * Is a reference allowed something right now? Pass `featureId` to check a grant/allowance (boolean
     * features check plan grants; metered features subtract usage tracked this period) or `priceId` to
     * check active access to a product. The feature path requires `entitlements` to be configured.
     */
    check: (input: CheckInput) => Promise<CheckResult>;
    createCheckout: (input: CheckoutInput) => Promise<CheckoutResult>;
    /** Open the provider billing portal for the caller's own customer (derived from the store). */
    createPortalSession: (referenceId: string, returnUrl: string) => Promise<{ url: string }>;
    /** Verify + normalize + apply a provider webhook. Always 200 once verified, even on no-op. */
    handleWebhook: (request: Request) => Promise<Response>;
    /** Resolve every configured feature's allowance for a reference in one call. Requires `entitlements`. */
    listBalances: (referenceId: string) => Promise<FeatureBalance[]>;
    listSubscriptions: (referenceId: string) => Promise<Subscription[]>;
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
            const balance = limit - used;

            return { allowed: balance >= need, balance, limit, unlimited: false, used };
        }

        return { allowed: entitlements.has(featureId), unlimited: entitlements.has(featureId) };
    };

    return {
        adapter,

        attach: async (input) => startCheckout({ ...input, mode: input.mode ?? "subscription" }),

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

            // Acknowledge once verified so the provider stops retrying — a no-op is still a 200.
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

            // `Promise.all` preserves the sorted `featureNames` order.
            return Promise.all(
                featureNames(options.entitlements).map(async (featureId) => {
                    return {
                        featureId,
                        ...(await evaluateFeature(entitlements, subscriptions, referenceId, featureId, 1)),
                    };
                }),
            );
        },

        listSubscriptions: async (referenceId) => {
            await ensureAuthorized(referenceId);

            return store.listSubscriptionsByReference(referenceId);
        },

        store,

        track: async (input) => {
            await ensureAuthorized(input.referenceId);

            const target = input.quantity ?? 1;
            // A caller-stable key dedupes retries; an omitted one means "always record".
            const key = input.idempotencyKey ?? crypto.randomUUID();

            // The ledger is append-only, so a "set" reconciles to the absolute total by recording the
            // delta from the current period usage; "add" records the increment directly.
            //
            // CONCURRENCY: `mode: "set"` is a non-atomic read-modify-write — the `sumUsage` read and the
            // `recordUsage` append below are separate `ctx.db` calls with no transaction spanning them,
            // so two `set` calls that interleave (e.g. two Worker isolates reconciling the same
            // reference) both read the same current total and both append their delta, over- or
            // under-counting the period. `mode: "add"` has no such hazard (its delta is independent of
            // the current total). Only call `mode: "set"` from a serialized context (a single DO, or a
            // per-reference lock); prefer `mode: "add"` for concurrent writers.
            let delta = target;

            if (input.mode === "set") {
                const subscriptions = await store.listSubscriptionsByReference(input.referenceId);
                const current = await store.sumUsage(input.referenceId, input.featureId, usagePeriodStart(subscriptions));

                delta = target - current;
            }

            // A no-op (set to the value it already holds, or add 0) writes nothing to the ledger.
            if (delta === 0) {
                return { recorded: false, reportedToProvider: false };
            }

            const recorded = await store.recordUsage({
                createdAt: Date.now(),
                featureId: input.featureId,
                idempotencyKey: key,
                provider: adapter.identifier,
                quantity: delta,
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
                // forward is retried out-of-band (the `usage.report_failed` signal + `reconcile`).
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
