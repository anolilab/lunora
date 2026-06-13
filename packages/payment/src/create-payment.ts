/**
 * The payment facade.
 *
 * Wraps an adapter + store with the cross-cutting guarantees every call needs: per-caller
 * authorization (no IDOR), outbound idempotency keys (no double-charge), and webhook ingestion
 * that verifies, normalizes, and applies through the FSM.
 */
import type { PaymentAdapter } from "./adapter";
import type { EntitlementsConfig } from "./entitlements";
import { resolveEntitlements, usagePeriodStart } from "./entitlements";
import { CirrusPaymentError } from "./errors";
import idempotencyKey from "./idempotency";
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
    Subscription,
    TrackInput,
    TrackResult,
} from "./types";

const jsonResponse = (body: unknown, status: number): Response => Response.json(body, { headers: { "content-type": "application/json" }, status });

/** Returns whether the current caller may act on `referenceId`. Throwing is also treated as denial. */
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

export interface CirrusPayment {
    readonly adapter: PaymentAdapter;

    /**
     * Subscribe a reference to a plan — a plan-oriented alias of {@link CirrusPayment.createCheckout}
     * with `mode` defaulting to `"subscription"`. Returns a hosted-checkout URL to redirect to.
     */
    attach: (input: AttachInput) => Promise<CheckoutResult>;
    cancelSubscription: (subscriptionId: string, options?: CancelSubscriptionOptions) => Promise<Subscription>;

    /**
     * Is a reference allowed to use a feature right now? Boolean features check plan grants; metered
     * features additionally subtract usage tracked this period. Requires `entitlements` to be configured.
     */
    check: (input: CheckInput) => Promise<CheckResult>;
    createCheckout: (input: CheckoutInput) => Promise<CheckoutResult>;
    /** Open the provider billing portal for the caller's own customer (derived from the store). */
    createPortalSession: (referenceId: string, returnUrl: string) => Promise<{ url: string }>;
    /** Verify + normalize + apply a provider webhook. Always 200 once verified, even on no-op. */
    handleWebhook: (request: Request) => Promise<Response>;
    listSubscriptions: (referenceId: string) => Promise<Subscription[]>;
    readonly store: PaymentStore;

    /**
     * Record metered usage for a reference's feature — durably (exactly-once by idempotency key) and,
     * when the provider supports it, forwarded to its metering API. Best-effort upstream: a reporting
     * failure is observed, never thrown, and the local ledger that `check` reads is always updated.
     */
    track: (input: TrackInput) => Promise<TrackResult>;
}

export const createPayment = (options: CreatePaymentOptions): CirrusPayment => {
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
            throw new CirrusPaymentError("FORBIDDEN", `caller not authorized for reference "${referenceId}"`);
        }

        if (!allowed) {
            throw new CirrusPaymentError("FORBIDDEN", `caller not authorized for reference "${referenceId}"`);
        }
    };

    // Shared by `createCheckout` and `attach`: reuse the reference's stored provider customer, only
    // minting a new one the first time, then delegate to the adapter with an outbound idempotency key.
    const startCheckout = async (input: CheckoutInput): Promise<CheckoutResult> => {
        await ensureAuthorized(input.referenceId);

        let { customerId } = input;

        if (!customerId) {
            const existing = await store.getCustomerByReference(adapter.identifier, input.referenceId);

            if (existing) {
                customerId = existing.id;
            } else {
                const customer = await adapter.getOrCreateCustomer({ referenceId: input.referenceId });

                customerId = customer.id;
                await store.upsertCustomer(customer);
            }
        }

        const key = input.idempotencyKey ?? idempotencyKey("checkout", adapter.identifier, input.referenceId, input.priceId, input.mode);

        return adapter.createCheckout({ ...input, customerId, idempotencyKey: key });
    };

    return {
        adapter,

        attach: async (input) => startCheckout({ ...input, mode: input.mode ?? "subscription" }),

        cancelSubscription: async (subscriptionId, cancelOptions) => {
            const existing = await store.getSubscription(adapter.identifier, subscriptionId);

            if (!existing) {
                throw new CirrusPaymentError("NOT_FOUND", `subscription "${subscriptionId}" not found`);
            }

            await ensureAuthorized(existing.referenceId);

            const key = cancelOptions?.idempotencyKey ?? idempotencyKey("cancel_subscription", adapter.identifier, subscriptionId);
            const updated = await adapter.cancelSubscription(subscriptionId, { ...cancelOptions, idempotencyKey: key });

            await store.upsertSubscription(updated);

            return updated;
        },

        check: async (input) => {
            await ensureAuthorized(input.referenceId);

            if (!options.entitlements) {
                throw new CirrusPaymentError("CONFIG_INVALID", "check() requires `entitlements` to be configured");
            }

            const need = input.quantity ?? 1;
            const subscriptions = await store.listSubscriptionsByReference(input.referenceId);
            const entitlements = resolveEntitlements(options.entitlements, subscriptions);
            const limit = entitlements.limit(input.featureId);

            // Metered feature: the plan grants a numeric cap; subtract usage tracked this period.
            if (limit !== undefined) {
                const used = await store.sumUsage(input.referenceId, input.featureId, usagePeriodStart(subscriptions));
                const balance = limit - used;

                return { allowed: balance >= need, balance, limit, unlimited: false, used };
            }

            // Boolean feature: granted (unlimited) or not.
            return { allowed: entitlements.has(input.featureId), unlimited: entitlements.has(input.featureId) };
        },

        createCheckout: async (input) => startCheckout(input),

        createPortalSession: async (referenceId, returnUrl) => {
            await ensureAuthorized(referenceId);

            // Derive the customer from the store — never trust a caller-supplied customer id (IDOR).
            const customer = await store.getCustomerByReference(adapter.identifier, referenceId);

            if (!customer) {
                throw new CirrusPaymentError("NOT_FOUND", `no customer for reference "${referenceId}"`);
            }

            return adapter.createPortalSession({ customerId: customer.id, returnUrl });
        },

        handleWebhook: async (request) => {
            let action;

            try {
                const payload = await request.text();

                action = await adapter.parseWebhook({ headers: request.headers, payload });
            } catch (error) {
                // Only surface our own (non-sensitive) error messages; mask anything unexpected.
                if (error instanceof CirrusPaymentError) {
                    return jsonResponse({ error: error.message }, error.status);
                }

                return jsonResponse({ error: "webhook error" }, 400);
            }

            const result = await applyWebhookAction(store, action, options.observability);

            // Acknowledge once verified so the provider stops retrying — a no-op is still a 200.
            return jsonResponse({ applied: result.applied, reason: result.reason }, 200);
        },

        listSubscriptions: async (referenceId) => {
            await ensureAuthorized(referenceId);

            return store.listSubscriptionsByReference(referenceId);
        },

        store,

        track: async (input) => {
            await ensureAuthorized(input.referenceId);

            const quantity = input.quantity ?? 1;
            // A caller-stable key dedupes retries; an omitted one means "always record".
            const key = input.idempotencyKey ?? crypto.randomUUID();

            const recorded = await store.recordUsage({
                createdAt: Date.now(),
                featureId: input.featureId,
                idempotencyKey: key,
                provider: adapter.identifier,
                quantity,
                referenceId: input.referenceId,
                reportedToProvider: false,
            });

            // A duplicate must not double-report upstream — bail before touching the provider.
            if (!recorded) {
                return { recorded: false, reportedToProvider: false };
            }

            if (!adapter.capabilities.usageMetering || !adapter.reportUsage) {
                return { recorded: true, reportedToProvider: false };
            }

            try {
                const customer = await store.getCustomerByReference(adapter.identifier, input.referenceId);

                await adapter.reportUsage({
                    customerId: customer?.id,
                    featureId: input.featureId,
                    idempotencyKey: key,
                    quantity,
                    referenceId: input.referenceId,
                });
                await store.markUsageReported(adapter.identifier, key);

                return { recorded: true, reportedToProvider: true };
            } catch {
                // Upstream metering is best-effort: the durable ledger `check` reads is already
                // updated, so a transient provider error can never fail the caller's request.
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
