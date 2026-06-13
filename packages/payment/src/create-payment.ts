/**
 * The payment facade.
 *
 * Wraps an adapter + store with the cross-cutting guarantees every call needs: per-caller
 * authorization (no IDOR), outbound idempotency keys (no double-charge), and webhook ingestion
 * that verifies, normalizes, and applies through the FSM.
 */
import type { PaymentAdapter } from "./adapter";
import { CirrusPaymentError } from "./errors";
import idempotencyKey from "./idempotency";
import type { PaymentStore } from "./store";
import applyWebhookAction from "./sync";
import type { CancelSubscriptionOptions, CheckoutInput, CheckoutResult, PortalInput, Subscription } from "./types";

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
    readonly store: PaymentStore;
}

export interface CirrusPayment {
    readonly adapter: PaymentAdapter;
    cancelSubscription: (subscriptionId: string, options?: CancelSubscriptionOptions) => Promise<Subscription>;
    createCheckout: (input: CheckoutInput) => Promise<CheckoutResult>;
    createPortalSession: (referenceId: string, input: PortalInput) => Promise<{ url: string }>;
    /** Verify + normalize + apply a provider webhook. Always 200 once verified, even on no-op. */
    handleWebhook: (request: Request) => Promise<Response>;
    listSubscriptions: (referenceId: string) => Promise<Subscription[]>;
    readonly store: PaymentStore;
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

    return {
        adapter,

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

        createCheckout: async (input) => {
            await ensureAuthorized(input.referenceId);

            let { customerId } = input;

            if (!customerId) {
                const customer = await adapter.getOrCreateCustomer({ email: undefined, referenceId: input.referenceId });

                customerId = customer.id;
                await store.upsertCustomer(customer);
            }

            const key = input.idempotencyKey ?? idempotencyKey("checkout", adapter.identifier, input.referenceId, input.priceId, input.mode);

            return adapter.createCheckout({ ...input, customerId, idempotencyKey: key });
        },

        createPortalSession: async (referenceId, input) => {
            await ensureAuthorized(referenceId);

            return adapter.createPortalSession(input);
        },

        handleWebhook: async (request) => {
            let action;

            try {
                const payload = await request.text();

                action = await adapter.parseWebhook({ headers: request.headers, payload });
            } catch (error) {
                const status = error instanceof CirrusPaymentError ? error.status : 400;

                return jsonResponse({ error: error instanceof Error ? error.message : "webhook error" }, status);
            }

            const result = await applyWebhookAction(store, action);

            // Acknowledge once verified so the provider stops retrying — a no-op is still a 200.
            return jsonResponse({ applied: result.applied, reason: result.reason }, 200);
        },

        listSubscriptions: async (referenceId) => {
            await ensureAuthorized(referenceId);

            return store.listSubscriptionsByReference(referenceId);
        },

        store,
    };
};
