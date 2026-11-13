import { describe, expect, it, vi } from "vitest";

import type { PaymentAdapter } from "../src/adapter";
import type { CreatePaymentOptions, WebhookOutcome } from "../src/create-payment";
import { createPayment, webhookResponse } from "../src/create-payment";
import { LunoraPaymentError } from "../src/errors";
import { derivedIdempotencyKey } from "../src/idempotency";
import { money } from "../src/money";
import type { PaymentObserver } from "../src/observability";
import type { PaymentStore, RevisionGuard } from "../src/store";
import { MemoryPaymentStore } from "../src/store";
import applyWebhookAction from "../src/sync";
import type { CheckoutRequest, PaymentSession, Subscription, WebhookAction } from "../src/types";
import { MAX_WEBHOOK_BODY_BYTES } from "../src/webhook-body";

const subscription = (referenceId: string, state: Subscription["state"]): Subscription => {
    return {
        cancelAtPeriodEnd: false,
        createdAt: 0,
        id: "sub_1",
        priceId: "price_1",
        provider: "stripe",
        quantity: 1,
        referenceId,
        state,
        updatedAt: 0,
    };
};

const paymentSession = (referenceId: string): PaymentSession => {
    return {
        amount: money(1000, "USD"),
        capturedAmount: money(1000, "USD"),
        createdAt: 0,
        id: "pi_1",
        provider: "stripe",
        referenceId,
        refundedAmount: money(0, "USD"),
        state: "captured",
        updatedAt: 0,
    };
};

const fakeAdapter = (overrides: Partial<PaymentAdapter> = {}): PaymentAdapter => {
    return {
        cancelPayment: async () => {
            throw new Error("not used");
        },
        cancelSubscription: async (id) => {
            return { ...subscription("user_1", "canceled"), id };
        },
        capabilities: { checkoutExpiry: true, merchantOfRecord: false, portal: true, usageMetering: true },
        capturePayment: async () => {
            throw new Error("not used");
        },
        createCheckout: async (input) => {
            return { id: "cs_1", provider: "stripe", url: `https://pay.test/${input.idempotencyKey ?? "none"}` };
        },
        createPortalSession: async () => {
            return { url: "https://portal.test" };
        },
        getOrCreateCustomer: async (ref) => {
            return { createdAt: 0, id: "cus_1", provider: "stripe", referenceId: ref.referenceId };
        },
        getPaymentStatus: async () => {
            throw new Error("not used");
        },
        getSubscriptionStatus: async () => subscription("user_1", "active"),
        identifier: "stripe",
        parseWebhook: async ({ payload }) => JSON.parse(payload) as WebhookAction,
        refundPayment: async () => {
            throw new Error("not used");
        },
        resumeSubscription: async (id) => {
            return { ...subscription("user_1", "active"), id };
        },
        updateSubscription: async (id) => {
            return { ...subscription("user_1", "active"), id };
        },
        ...overrides,
    };
};

describe("createPayment", () => {
    it("derives an outbound idempotency key for checkout", async () => {
        expect.assertions(1);

        const payment = createPayment({ adapter: fakeAdapter(), authorize: () => true, store: new MemoryPaymentStore() });

        const result = await payment.createCheckout({
            cancelUrl: "https://x/cancel",
            mode: "subscription",
            priceId: "price_1",
            referenceId: "user_1",
            successUrl: "https://x/ok",
        });

        // The derived key is a hash of the request-shaping fields: a fixed-length `checkout:<provider>:<sha256>`
        // that stays well under Stripe's 255-char idempotency-key limit no matter how long the URLs/metadata are.
        expect(result.url).toMatch(/^https:\/\/pay\.test\/checkout:stripe:[0-9a-f]{64}$/);
    });

    it("derives a fixed-length checkout key that avoids length overflow and delimiter collisions", async () => {
        expect.assertions(4);

        const keyFor = async (successUrl: string, cancelUrl: string): Promise<string> => {
            let forwarded = "";
            const adapter = fakeAdapter({
                createCheckout: async (input) => {
                    forwarded = input.idempotencyKey ?? "";

                    return { id: "cs_1", provider: "stripe", url: "https://pay.test/ok" };
                },
            });
            const payment = createPayment({ adapter, authorize: () => true, store: new MemoryPaymentStore() });

            await payment.createCheckout({ cancelUrl, mode: "payment", priceId: "price_1", referenceId: "user_1", successUrl });

            return forwarded;
        };

        // Two full URLs plus a long query string used to blow past Stripe's 255-char key limit; the hash keeps it fixed.
        const longUrl = `https://example.com/return?token=${"a".repeat(400)}`;
        const longKey = await keyFor(longUrl, longUrl);

        expect(longKey.length).toBeLessThanOrEqual(255);
        expect(longKey).toMatch(/^checkout:stripe:[0-9a-f]{64}$/);

        // Unescaped ':' joining would make these two distinct (successUrl, cancelUrl) pairs collide onto the
        // same key; hashing a JSON-encoded parts array keeps them distinct.
        const collideA = await keyFor("https://a/x:y", "z");
        const collideB = await keyFor("https://a/x", "y:z");

        expect(collideA).not.toBe(collideB);
        // Same inputs are still deterministic (a genuine retry dedupes).
        await expect(keyFor("https://a/x:y", "z")).resolves.toBe(collideA);
    });

    it("varies the checkout idempotency key with every request-shaping field", async () => {
        expect.assertions(9);

        const base = {
            cancelUrl: "https://x/cancel",
            mode: "subscription" as const,
            priceId: "price_1",
            referenceId: "user_1",
            successUrl: "https://x/ok",
        };
        const keyFor = async (overrides: Partial<Parameters<ReturnType<typeof createPayment>["createCheckout"]>[0]> = {}): Promise<string> => {
            let forwarded = "";
            const adapter = fakeAdapter({
                createCheckout: async (input) => {
                    forwarded = input.idempotencyKey ?? "";

                    return { id: "cs_1", provider: "stripe", url: "https://pay.test/ok" };
                },
            });
            const payment = createPayment({ adapter, authorize: () => true, store: new MemoryPaymentStore() });

            await payment.createCheckout({ ...base, ...overrides });

            return forwarded;
        };

        const baseline = await keyFor();

        // referenceId is the tenant discriminator: two users buying the SAME single-plan checkout
        // (identical price, mode, URLs) must not share a key, or the provider's idempotency window
        // replays user A's session URL to user B.
        await expect(keyFor({ referenceId: "user_2" })).resolves.not.toBe(baseline);
        await expect(keyFor({ priceId: "price_2" })).resolves.not.toBe(baseline);
        await expect(keyFor({ mode: "payment" })).resolves.not.toBe(baseline);
        await expect(keyFor({ quantity: 2 })).resolves.not.toBe(baseline);
        await expect(keyFor({ successUrl: "https://x/ok2" })).resolves.not.toBe(baseline);
        await expect(keyFor({ cancelUrl: "https://x/cancel2" })).resolves.not.toBe(baseline);
        await expect(keyFor({ metadata: { plan: "pro" } })).resolves.not.toBe(baseline);
        await expect(keyFor({ expiresAt: 1_800_000_000_000 })).resolves.not.toBe(baseline);

        // An identical repeat still dedupes onto the same key.
        await expect(keyFor()).resolves.toBe(baseline);
    });

    it("refuses a checkout expiry the provider cannot honour, before reaching it", async () => {
        expect.assertions(2);

        const createCheckout = vi.fn<PaymentAdapter["createCheckout"]>();
        const adapter = fakeAdapter({ capabilities: { checkoutExpiry: false, merchantOfRecord: true, portal: true, usageMetering: false }, createCheckout });
        const payment = createPayment({ adapter, authorize: () => true, store: new MemoryPaymentStore() });

        await expect(
            payment.createCheckout({
                expiresAt: 1_800_000_000_000,
                mode: "subscription",
                priceId: "price_1",
                referenceId: "user_1",
                successUrl: "https://x/ok",
            }),
        ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
        expect(createCheckout).not.toHaveBeenCalled();
    });

    it("denies when the authorizer returns a truthy non-boolean", async () => {
        expect.assertions(1);

        // An untyped authorizer that hands back the looked-up row (or an
        // `{ allowed: false }` verdict object) must not authorize a charge against
        // someone else's reference — only an exact `true` does.
        const payment = createPayment({
            adapter: fakeAdapter(),
            authorize: () => ({ allowed: false }) as unknown as boolean,
            store: new MemoryPaymentStore(),
        });

        await expect(
            payment.createCheckout({
                cancelUrl: "https://x/cancel",
                mode: "payment",
                priceId: "price_1",
                referenceId: "user_1",
                successUrl: "https://x/ok",
            }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("enforces authorization on the referenceId", async () => {
        expect.assertions(1);

        const payment = createPayment({
            adapter: fakeAdapter(),
            authorize: (referenceId) => referenceId === "user_1",
            store: new MemoryPaymentStore(),
        });

        await expect(
            payment.createCheckout({
                cancelUrl: "https://x/cancel",
                mode: "payment",
                priceId: "price_1",
                referenceId: "user_2",
                successUrl: "https://x/ok",
            }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("denies checkout for a foreign reference and never reaches the provider", async () => {
        expect.assertions(2);

        let providerCalls = 0;
        const adapter = fakeAdapter({
            createCheckout: async () => {
                providerCalls += 1;

                return { id: "cs_1", provider: "stripe", url: "https://pay.test/ok" };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store: new MemoryPaymentStore() });

        await expect(
            payment.createCheckout({
                cancelUrl: "https://x/cancel",
                mode: "payment",
                priceId: "price_1",
                referenceId: "user_2",
                successUrl: "https://x/ok",
            }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(providerCalls).toBe(0);
    });

    it("denies capture and refund of a session owned by another reference, without reaching the provider", async () => {
        expect.assertions(4);

        const store = new MemoryPaymentStore();

        await store.upsertPaymentSession({ ...paymentSession("user_2"), capturedAmount: money(1000, "USD"), state: "captured" });

        let providerCalls = 0;
        const adapter = fakeAdapter({
            capturePayment: async () => {
                providerCalls += 1;

                return paymentSession("user_2");
            },
            refundPayment: async () => {
                providerCalls += 1;

                return paymentSession("user_2");
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        // A foreign session collapses to NOT_FOUND, the same as a missing one (no existence oracle).
        await expect(payment.capturePayment({ sessionId: "pi_1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(payment.refundPayment({ sessionId: "pi_1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(providerCalls).toBe(0);
        await expect(store.getPaymentSession("stripe", "pi_1")).resolves.toMatchObject({ referenceId: "user_2", refundedAmount: money(0, "USD") });
    });

    it("denies checkout when the authorizer throws", async () => {
        expect.assertions(2);

        let providerCalls = 0;
        const adapter = fakeAdapter({
            createCheckout: async () => {
                providerCalls += 1;

                return { id: "cs_1", provider: "stripe", url: "https://pay.test/ok" };
            },
        });
        const payment = createPayment({
            adapter,
            authorize: () => {
                throw new Error("session lookup failed");
            },
            store: new MemoryPaymentStore(),
        });

        await expect(
            payment.createCheckout({
                cancelUrl: "https://x/cancel",
                mode: "payment",
                priceId: "price_1",
                referenceId: "user_1",
                successUrl: "https://x/ok",
            }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(providerCalls).toBe(0);
    });

    it("rejects an untyped caller that omits authorize at construction, so the factory cannot default open", () => {
        expect.assertions(2);

        // Untyped JavaScript reaches the factory without the required option. Construction fails with a
        // configuration error, so no facade exists to reach the provider.
        let caught: unknown;

        try {
            createPayment({ adapter: fakeAdapter(), store: new MemoryPaymentStore() } as unknown as CreatePaymentOptions);
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(LunoraPaymentError);
        expect(caught).toMatchObject({ code: "CONFIG_INVALID" });
    });

    it("ignores a caller-supplied customerId, forwarding the store's customer for the reference", async () => {
        expect.assertions(2);

        // Capture whatever `customerId` the facade actually hands the provider.
        let forwarded: string | undefined = "unset";
        const adapter = fakeAdapter({
            createCheckout: async (input) => {
                forwarded = input.customerId;

                return { id: "cs_1", provider: "stripe", url: "https://pay.test/ok" };
            },
        });
        const store = new MemoryPaymentStore();

        // The reference already has a legitimate stored customer.
        await store.upsertCustomer({ createdAt: 0, id: "cus_legit", provider: "stripe", referenceId: "user_1" });

        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        // An untyped caller's attacker-chosen victim customer — dropped in favor of the store-derived one.
        await payment.createCheckout({
            cancelUrl: "https://x/cancel",
            customerId: "cus_victim",
            mode: "payment",
            priceId: "price_1",
            referenceId: "user_1",
            successUrl: "https://x/ok",
        } as CheckoutRequest);

        expect(forwarded).toBe("cus_legit");
        expect(forwarded).not.toBe("cus_victim");
    });

    it("ignores a caller-supplied customerId on an empty store, minting a fresh customer instead", async () => {
        expect.assertions(2);

        let forwarded: string | undefined = "unset";
        const adapter = fakeAdapter({
            createCheckout: async (input) => {
                forwarded = input.customerId;

                return { id: "cs_1", provider: "stripe", url: "https://pay.test/ok" };
            },
        });
        // No stored customer for the reference — the facade mints one via getOrCreateCustomer ("cus_1").
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store: new MemoryPaymentStore() });

        await payment.createCheckout({
            cancelUrl: "https://x/cancel",
            customerId: "cus_victim",
            mode: "payment",
            priceId: "price_1",
            referenceId: "user_1",
            successUrl: "https://x/ok",
        } as CheckoutRequest);

        expect(forwarded).toBe("cus_1");
        expect(forwarded).not.toBe("cus_victim");
    });

    it("starts an unbound checkout, storing no customer, when the adapter can't give the reference one", async () => {
        expect.assertions(2);

        let forwarded: string | undefined = "unset";
        const store = new MemoryPaymentStore();
        const adapter = fakeAdapter({
            createCheckout: async (input) => {
                forwarded = input.customerId;

                return { id: "cs_1", provider: "stripe", url: "https://pay.test/ok" };
            },
            getOrCreateCustomer: async () => undefined,
        });
        const payment = createPayment({ adapter, authorize: () => true, store });

        await payment.createCheckout({ email: "a@x.test", mode: "subscription", priceId: "price_1", referenceId: "org_1", successUrl: "https://x/ok" });

        expect(forwarded).toBeUndefined();
        await expect(store.getCustomerByReference("stripe", "org_1")).resolves.toBeUndefined();
    });

    it("rejects cancelling another caller's subscription as NOT_FOUND (no existence oracle)", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_2", "active"));

        const payment = createPayment({ adapter: fakeAdapter(), authorize: (referenceId) => referenceId === "user_1", store });

        // A non-owner gets the same NOT_FOUND as a truly missing id, so the endpoint can't be used to
        // confirm another tenant's subscription id exists.
        await expect(payment.cancelSubscription("sub_1")).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(payment.cancelSubscription("sub_absent")).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("cancels an owned subscription and syncs the store", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_1", "active"));

        const payment = createPayment({ adapter: fakeAdapter(), authorize: (referenceId) => referenceId === "user_1", store });
        const updated = await payment.cancelSubscription("sub_1");

        expect(updated.state).toBe("canceled");

        const stored = await store.getSubscription("stripe", "sub_1");

        expect(stored?.state).toBe("canceled");
    });

    it("keeps a past-due row past-due when the cancel response reports it active", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();
        const observer = vi.fn<PaymentObserver>();

        await store.upsertSubscription({ ...subscription("user_1", "active"), id: "sub_2" });
        await store.upsertSubscription(subscription("user_1", "past_due"));

        // The provider reports the scheduled cancellation as still active.
        const adapter = fakeAdapter({
            cancelSubscription: async (id) => {
                return { ...subscription("user_1", "active"), id };
            },
        });
        const payment = createPayment({
            adapter,
            authorize: (referenceId) => referenceId === "user_1",
            observability: observer,
            singleSubscriptionPerReference: true,
            store,
        });

        const returned = await payment.cancelSubscription("sub_1");

        expect(returned.state).toBe("past_due");
        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ state: "past_due" });
        expect(observer).toHaveBeenCalledWith({ provider: "stripe", subscriptionId: "sub_1", type: "subscription.duplicate" });
    });

    it("still takes the provider's state for a cancel response when the policy is off", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_1", "past_due"));

        const adapter = fakeAdapter({
            cancelSubscription: async (id) => {
                return { ...subscription("user_1", "active"), id };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        await expect(payment.cancelSubscription("sub_1")).resolves.toMatchObject({ state: "active" });
        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ state: "active" });
    });

    it("takes a provider's recovery on a cancel response when no other live subscription holds the reference", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_1", "past_due"));

        // Stripe has recovered the subscription, and its webhook has not arrived yet.
        const adapter = fakeAdapter({
            cancelSubscription: async (id) => {
                return { ...subscription("user_1", "active"), id };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", singleSubscriptionPerReference: true, store });

        await expect(payment.cancelSubscription("sub_1")).resolves.toMatchObject({ state: "active" });
        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ state: "active" });
    });

    it("keeps a webhook that lands during the cancel call instead of overwriting it with the response", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_1", "past_due"));

        // While the provider call is in flight, a webhook activates the row.
        const adapter = fakeAdapter({
            cancelSubscription: async (id) => {
                await store.upsertSubscription({ ...subscription("user_1", "active"), id });

                return { ...subscription("user_1", "past_due"), id };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        await expect(payment.cancelSubscription("sub_1")).resolves.toMatchObject({ state: "active" });
        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ state: "active" });
    });

    it("does not adopt an owner the cancel response names into a blank row another live subscription holds", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();
        const observer = vi.fn<PaymentObserver>();

        await store.upsertSubscription({ ...subscription("user_1", "active"), id: "sub_live" });
        await store.upsertSubscription({ ...subscription("", "active"), id: "sub_blank" });

        // The app's authorizer admits a blank owner, and the provider names one in its response.
        const adapter = fakeAdapter({
            cancelSubscription: async (id) => {
                return { ...subscription("user_1", "active"), id };
            },
        });
        const payment = createPayment({
            adapter,
            authorize: () => true,
            observability: observer,
            singleSubscriptionPerReference: true,
            store,
        });

        await payment.cancelSubscription("sub_blank");

        // Recorded under the owner the provider named, as paused: it grants nothing, and the customer can still cancel it.
        await expect(store.getSubscription("stripe", "sub_blank")).resolves.toMatchObject({ referenceId: "user_1", state: "paused" });
        await expect(store.listSubscriptionsByReference("user_1")).resolves.toHaveLength(2);
        expect(observer).toHaveBeenCalledWith({ provider: "stripe", subscriptionId: "sub_blank", type: "subscription.duplicate" });
    });

    it("lets the customer cancel a subscription the policy refused, because the refusal is recorded", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription({ ...subscription("user_1", "active"), id: "sub_live" });
        await applyWebhookAction(
            store,
            { eventId: "e1", priceId: "prod_team", provider: "stripe", referenceId: "user_1", subscriptionId: "sub_2", type: "subscription.active" },
            undefined,
            true,
        );

        const adapter = fakeAdapter({
            cancelSubscription: async (id) => {
                return { ...subscription("user_1", "canceled"), id };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", singleSubscriptionPerReference: true, store });

        await expect(payment.cancelSubscription("sub_2")).resolves.toMatchObject({ id: "sub_2", state: "canceled" });
        await expect(store.getSubscription("stripe", "sub_2")).resolves.toMatchObject({ state: "canceled" });
    });

    it("records a cancel even when a non-newer webhook moves the row during the provider call", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_1", "active"));

        // A renewal webhook lands during the call. It is not newer than the cancel, but it moves the row.
        const adapter = fakeAdapter({
            cancelSubscription: async (id) => {
                await store.upsertSubscription({ ...subscription("user_1", "active"), id, priceId: "price_renewed" });

                return { ...subscription("user_1", "canceled"), id };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        await expect(payment.cancelSubscription("sub_1")).resolves.toMatchObject({ state: "canceled" });
        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ priceId: "price_renewed", state: "canceled" });
    });

    it("keeps a cancel when the row moves again while the cancel is being recorded", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_1", "active"));

        // The first three guarded writes lose a race with other writers, then the row settles.
        let losses = 3;
        const racing = Object.assign(Object.create(store) as object, {
            upsertSubscription: (record: Subscription, guard?: RevisionGuard) => {
                if (guard !== undefined && losses > 0) {
                    losses -= 1;

                    return Promise.resolve(false);
                }

                return store.upsertSubscription(record, guard);
            },
        }) as PaymentStore;

        const adapter = fakeAdapter({
            cancelSubscription: async (id) => {
                return { ...subscription("user_1", "canceled"), id };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store: racing });

        await expect(payment.cancelSubscription("sub_1")).resolves.toMatchObject({ state: "canceled" });
        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ state: "canceled" });
    });

    it("raises a conflict rather than dropping a cancel when the row moves through every guarded attempt", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_1", "active"));

        // Every guarded write loses a race, so the cancel cannot be recorded.
        const racing = Object.assign(Object.create(store) as object, {
            upsertSubscription: (record: Subscription, guard?: RevisionGuard) => {
                if (guard !== undefined) {
                    return Promise.resolve(false);
                }

                return store.upsertSubscription(record, guard);
            },
        }) as PaymentStore;

        const adapter = fakeAdapter({
            cancelSubscription: async (id) => {
                return { ...subscription("user_1", "canceled"), id };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store: racing });

        await expect(payment.cancelSubscription("sub_1")).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ state: "active" });
    });

    it("keeps the stored subscription's referenceId when the cancel response doesn't echo it", async () => {
        expect.assertions(3);

        // Regression: the adapter's cancel response was written to the store wholesale. It maps a
        // MUTATION payload, which need not echo the checkout metadata `referenceId` is pinned in —
        // Creem and Dodo then fall back to the provider's own CUSTOMER id, Stripe and Polar to `""`.
        // Either orphans the row from `by_reference`, `check`/`hasActivePrice` and the default
        // authorizer, permanently: `sync.ts` never rewrites the field on a later update.
        const store = new MemoryPaymentStore();

        await store.upsertSubscription({ ...subscription("user_1", "active"), provider: "creem" });

        const adapter = fakeAdapter({
            cancelSubscription: async (id) => {
                return { ...subscription("cust_abc", "canceled"), id, provider: "creem" as const };
            },
            identifier: "creem",
        });
        const payment = createPayment({ adapter, authorize: () => true, store });

        const updated = await payment.cancelSubscription("sub_1");

        // The lifecycle state IS the adapter's to report; the owner is not.
        expect(updated.state).toBe("canceled");
        expect(updated.referenceId).toBe("user_1");

        // The row is still reachable by reference — the index `check`/`hasActivePrice` and the default
        // authorizer read.
        await expect(store.listSubscriptionsByReference("user_1")).resolves.toHaveLength(1);
    });

    it("keeps the stored row's identity and amounts when an adapter returns a placeholder session", async () => {
        expect.assertions(5);

        const store = new MemoryPaymentStore();

        await store.upsertPaymentSession(paymentSession("user_1"));

        // Polar's `refundPayment` shape: every money field pinned to the REFUND amount and no
        // reference at all. Persisting it verbatim would rewrite a 1000-captured row to 300 and
        // orphan it from `by_reference`, making every later facade call fail the authorizer.
        const adapter = fakeAdapter({
            refundPayment: async (input) => {
                const refunded = input.amount ?? money(1000, "USD");

                return {
                    amount: refunded,
                    capturedAmount: refunded,
                    createdAt: Date.now(),
                    id: input.sessionId,
                    provider: "stripe",
                    referenceId: "",
                    refundedAmount: refunded,
                    state: "refunded",
                    updatedAt: Date.now(),
                };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        await payment.refundPayment({ amount: money(300, "USD"), sessionId: "pi_1" });

        const stored = await store.getPaymentSession("stripe", "pi_1");

        expect(stored?.referenceId).toBe("user_1");
        expect(stored?.amount.minorUnits).toBe(1000n);
        expect(stored?.capturedAmount.minorUnits).toBe(1000n);
        // A partial refund is `partially_refunded` even though the adapter reported "refunded".
        expect(stored?.state).toBe("partially_refunded");
        // The refunded TOTAL is recorded from what this call issued, not left to the webhook: it is
        // what stops a retry from issuing the refund a second time.
        expect(stored?.refundedAmount.minorUnits).toBe(300n);
    });

    it("records the refund it issued, so a second refund never reaches the provider", async () => {
        expect.assertions(4);

        const store = new MemoryPaymentStore();

        await store.upsertPaymentSession(paymentSession("user_1"));

        let calls = 0;
        const adapter = fakeAdapter({
            refundPayment: async () => {
                calls += 1;

                return { ...paymentSession("user_1"), refundedAmount: money(1000, "USD") };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        const refunded = await payment.refundPayment({ sessionId: "pi_1" });

        expect(refunded.refundedAmount.minorUnits).toBe(1000n);
        expect(refunded.state).toBe("refunded");

        // No webhook has arrived yet. The local ledger alone must hold the over-refund guard — the
        // refund call carries no idempotency key the provider honors (see `idempotency.ts`).
        await expect(payment.refundPayment({ amount: money(500, "USD"), sessionId: "pi_1" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

        expect(calls).toBe(1);
    });

    it("folds the provider's confirming refund webhook in without double-counting (absolute)", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();

        await store.upsertPaymentSession(paymentSession("user_1"));

        const adapter = fakeAdapter({
            refundPayment: async () => {
                return { ...paymentSession("user_1"), refundedAmount: money(1000, "USD") };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        await payment.refundPayment({ sessionId: "pi_1" });

        // Stripe's `charge.refunded` restates the cumulative refunded-to-date on a row the facade
        // already moved to "refunded" — it must apply (idempotently), not bounce off the FSM.
        const applied = await applyWebhookAction(store, {
            amount: money(1000, "USD"),
            amountKind: "absolute",
            eventId: "evt_1",
            provider: "stripe",
            sessionId: "pi_1",
            type: "payment.refunded",
        });

        expect(applied).toEqual({ applied: true, reason: "ok" });

        const stored = await store.getPaymentSession("stripe", "pi_1");

        expect(stored?.refundedAmount.minorUnits).toBe(1000n);
        expect(stored?.state).toBe("refunded");
    });

    it("folds the provider's confirming refund webhook in without double-counting (delta)", async () => {
        expect.assertions(6);

        const store = new MemoryPaymentStore();
        const polarSession = { ...paymentSession("user_1"), id: "ord_1", provider: "polar" as const };

        await store.upsertPaymentSession(polarSession);

        const adapter = fakeAdapter({
            identifier: "polar",
            refundPayment: async (input) => {
                return { ...polarSession, refundedAmount: input.amount ?? money(1000, "USD") };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });
        const refundEvent = (eventId: string, minorUnits: number): WebhookAction => {
            return { amount: money(minorUnits, "USD"), eventId, provider: "polar", sessionId: "ord_1", type: "payment.refunded" };
        };

        await payment.refundPayment({ amount: money(300, "USD"), sessionId: "ord_1" });

        // Polar reports ONE refund per event, so its `refund.created` is a delta. It is the same 300
        // the facade just recorded: the running total must stay 300, not become 600.
        await applyWebhookAction(store, refundEvent("evt_a", 300));

        const afterPartial = await store.getPaymentSession("polar", "ord_1");

        expect(afterPartial?.refundedAmount.minorUnits).toBe(300n);
        expect(afterPartial?.state).toBe("partially_refunded");

        await payment.refundPayment({ sessionId: "ord_1" });
        await applyWebhookAction(store, refundEvent("evt_b", 700));

        const afterFull = await store.getPaymentSession("polar", "ord_1");

        expect(afterFull?.refundedAmount.minorUnits).toBe(1000n);
        expect(afterFull?.state).toBe("refunded");

        // A refund issued from the provider's dashboard is NOT the facade's — its delta still counts,
        // and here it would push the total past the capture, so it is rejected rather than absorbed.
        await expect(applyWebhookAction(store, refundEvent("evt_c", 100))).resolves.toEqual({ applied: false, reason: "invalid_refund_amount" });

        const afterDashboard = await store.getPaymentSession("polar", "ord_1");

        expect(afterDashboard?.refundedAmount.minorUnits).toBe(1000n);
    });

    it("keeps two same-amount refunds on one session distinct, by the provider's refund id", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();
        const polarSession = { ...paymentSession("user_1"), id: "ord_1", provider: "polar" as const };

        await store.upsertPaymentSession(polarSession);

        // This double issues on EVERY call, which is Polar's real behaviour and not a general one:
        // Polar's `refunds.create` accepts no idempotency key at all (`idempotency.ts`), so the
        // derived key never reaches the wire and two same-amount calls are two distinct refunds with
        // two distinct ids. A provider that DOES honour the key replays instead of issuing — see
        // "does not fold a replayed refund into the ledger" below for that half.
        let issued = 0;
        const adapter = fakeAdapter({
            identifier: "polar",
            refundPayment: async (input) => {
                issued += 1;

                return { ...polarSession, refundedAmount: input.amount ?? money(1000, "USD"), refundId: `ref_${String(issued)}` };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });
        const refundEvent = (eventId: string, refundId: string): WebhookAction => {
            return { amount: money(300, "USD"), eventId, provider: "polar", refundId, sessionId: "ord_1", type: "payment.refunded" };
        };

        // Two SEPARATE refunds of the identical amount, both in flight before either webhook lands.
        await payment.refundPayment({ amount: money(300, "USD"), sessionId: "ord_1" });
        await payment.refundPayment({ amount: money(300, "USD"), sessionId: "ord_1" });

        const beforeWebhooks = await store.getPaymentSession("polar", "ord_1");

        expect(beforeWebhooks?.refundedAmount.minorUnits).toBe(600n);

        // Each confirming delta consumes ITS OWN marker. Keyed on the amount the two would share one,
        // so the second event would find it already consumed and add 300 a third time.
        await applyWebhookAction(store, refundEvent("evt_a", "ref_1"));
        await applyWebhookAction(store, refundEvent("evt_b", "ref_2"));

        const afterWebhooks = await store.getPaymentSession("polar", "ord_1");

        expect(afterWebhooks?.refundedAmount.minorUnits).toBe(600n);
        expect(afterWebhooks?.state).toBe("partially_refunded");
    });

    it("does not fold a replayed refund into the ledger", async () => {
        expect.assertions(4);

        // Regression: the refund key is derived from (session, amount, reason), so two same-amount
        // refunds on one session share it. A provider that HONOURS the key — Stripe — then replays the
        // first refund and moves no money, while the facade added the amount to the ledger anyway.
        // That phantom total compounds: the absolute `charge.refunded` webhook resolves to `max(...)`
        // and keeps it, the over-refund guard blocks the real second refund, and "refund the rest"
        // hands back a remainder computed from the inflated figure — leaving the customer short by
        // exactly the phantom amount, with no way to recover it through the facade.
        const store = new MemoryPaymentStore();
        const captured = { ...paymentSession("user_1"), amount: money(10_000, "USD"), capturedAmount: money(10_000, "USD") };

        await store.upsertPaymentSession(captured);

        // Stripe's idempotency window: a key seen before replays the original response and issues
        // nothing. The `refundId` comes back unchanged, which is what identifies it as a replay.
        const byKey = new Map<string, { amount: bigint; refundId: string }>();
        const issued: bigint[] = [];
        const adapter = fakeAdapter({
            refundPayment: async (input) => {
                const key = input.idempotencyKey ?? "";
                const replayed = byKey.get(key);

                if (replayed) {
                    return { ...captured, refundedAmount: money(replayed.amount, "USD"), refundId: replayed.refundId };
                }

                const amount = input.amount?.minorUnits ?? captured.capturedAmount.minorUnits;

                issued.push(amount);
                byKey.set(key, { amount, refundId: `re_${String(issued.length)}` });

                return { ...captured, refundedAmount: money(amount, "USD"), refundId: `re_${String(issued.length)}` };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        await payment.refundPayment({ amount: money(2000, "USD"), sessionId: "pi_1" });
        await payment.refundPayment({ amount: money(2000, "USD"), sessionId: "pi_1" });

        // One refund reached Stripe, so the ledger must hold one refund.
        expect(issued).toStrictEqual([2000n]);
        await expect(store.getPaymentSession("stripe", "pi_1").then((row) => row?.refundedAmount.minorUnits)).resolves.toBe(2000n);

        // "Refund the rest" now asks for the true remainder, and the two sides agree.
        await payment.refundPayment({ sessionId: "pi_1" });

        expect(issued).toStrictEqual([2000n, 8000n]);
        await expect(store.getPaymentSession("stripe", "pi_1").then((row) => row?.refundedAmount.minorUnits)).resolves.toBe(10_000n);
    });

    it("books the amount the provider reports refunding, not the amount asked for", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();
        const polarSession = { ...paymentSession("user_1"), id: "ord_1", provider: "polar" as const };

        await store.upsertPaymentSession(polarSession);

        // Polar caps the refund at the order's refundable amount and adds tax, so it can differ.
        const adapter = fakeAdapter({
            identifier: "polar",
            refundPayment: async () => {
                return { ...polarSession, refundedAmount: money(250, "USD"), refundId: "ref_1" };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        await payment.refundPayment({ amount: money(300, "USD"), sessionId: "ord_1" });

        await expect(store.getPaymentSession("polar", "ord_1").then((row) => row?.refundedAmount.minorUnits)).resolves.toBe(250n);

        // The confirming webhook for the same refund id adds nothing on top.
        await applyWebhookAction(store, {
            amount: money(250, "USD"),
            eventId: "evt_1",
            provider: "polar",
            refundId: "ref_1",
            sessionId: "ord_1",
            type: "payment.refunded",
        });

        await expect(store.getPaymentSession("polar", "ord_1").then((row) => row?.refundedAmount.minorUnits)).resolves.toBe(250n);
    });

    it("books the amount asked for when the provider reports a zero amount (security regression)", async () => {
        expect.assertions(1);

        const store = new MemoryPaymentStore();
        const dodoSession = { ...paymentSession("user_1"), id: "pay_1", provider: "dodopayments" as const };

        await store.upsertPaymentSession(dodoSession);

        // Dodo's response can omit the amount, which the adapter reads as 0. Booking that would claim
        // the refund id's marker for nothing, and the confirming webhook would then be a duplicate.
        const adapter = fakeAdapter({
            identifier: "dodopayments",
            refundPayment: async () => {
                return { ...dodoSession, refundedAmount: money(0, "USD"), refundId: "ref_1" };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        await payment.refundPayment({ sessionId: "pay_1" });

        await expect(store.getPaymentSession("dodopayments", "pay_1").then((row) => row?.refundedAmount.minorUnits)).resolves.toBe(1000n);
    });

    it("asks the provider for the remainder when a full refund follows a partial one", async () => {
        expect.assertions(4);

        const store = new MemoryPaymentStore();
        const polarSession = { ...paymentSession("user_1"), id: "ord_1", provider: "polar" as const };

        await store.upsertPaymentSession(polarSession);

        const forwarded: (bigint | undefined)[] = [];
        const adapter = fakeAdapter({
            identifier: "polar",
            refundPayment: async (input) => {
                forwarded.push(input.amount?.minorUnits);

                return { ...polarSession, refundedAmount: input.amount ?? money(1000, "USD"), refundId: `ref_${String(forwarded.length)}` };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        await payment.refundPayment({ amount: money(300, "USD"), sessionId: "ord_1" });
        await payment.refundPayment({ sessionId: "ord_1" });

        // An omitted amount means "whatever is left", not "the whole order". Polar reads the order
        // total when no amount is given, so forwarding `undefined` here would refund 1000 on a session
        // that already had 300 back — 1300 moved against a ledger that records 1000.
        expect(forwarded[0]).toBe(300n);
        expect(forwarded[1]).toBe(700n);

        const stored = await store.getPaymentSession("polar", "ord_1");

        expect(stored?.refundedAmount.minorUnits).toBe(1000n);
        expect(stored?.state).toBe("refunded");
    });

    it("refunds nothing more once the captured amount is fully refunded", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertPaymentSession({ ...paymentSession("user_1"), refundedAmount: money(1000, "USD"), state: "refunded" });

        let calls = 0;
        const adapter = fakeAdapter({
            refundPayment: async () => {
                calls += 1;

                return { ...paymentSession("user_1"), refundedAmount: money(1000, "USD"), state: "refunded" };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        const result = await payment.refundPayment({ sessionId: "pi_1" });

        // Zero remainder: the over-refund guard cannot catch this (the total does not move), so the
        // call must stop here rather than let a provider read the order total and refund it again.
        expect(calls).toBe(0);
        expect(result.refundedAmount.minorUnits).toBe(1000n);
    });

    it("releases the local refund marker when the row write fails, so the webhook still carries the refund", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();
        const polarSession = { ...paymentSession("user_1"), id: "ord_1", provider: "polar" as const };

        await store.upsertPaymentSession(polarSession);

        let failNext = true;
        const failingStore = Object.create(store) as MemoryPaymentStore;

        failingStore.upsertPaymentSession = async (session) => {
            if (failNext) {
                failNext = false;

                throw new Error("row write failed");
            }

            return store.upsertPaymentSession(session);
        };

        const adapter = fakeAdapter({
            identifier: "polar",
            refundPayment: async () => {
                return { ...polarSession, refundId: "ref_1" };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store: failingStore });

        await expect(payment.refundPayment({ amount: money(300, "USD"), sessionId: "ord_1" })).rejects.toThrow("row write failed");

        const afterFailure = await store.getPaymentSession("polar", "ord_1");

        expect(afterFailure?.refundedAmount.minorUnits).toBe(0n);

        // The marker stands for a fold that never happened. Left behind, Polar's confirming delta
        // consumes it and contributes nothing — the refund would be absent from the row for good.
        await applyWebhookAction(store, {
            amount: money(300, "USD"),
            eventId: "evt_a",
            provider: "polar",
            refundId: "ref_1",
            sessionId: "ord_1",
            type: "payment.refunded",
        });

        const afterWebhook = await store.getPaymentSession("polar", "ord_1");

        expect(afterWebhook?.refundedAmount.minorUnits).toBe(300n);
    });

    it("leaves the ledger alone for a refund the provider has not settled yet", async () => {
        expect.assertions(5);

        const store = new MemoryPaymentStore();
        const dodoSession = { ...paymentSession("user_1"), id: "pay_1", provider: "dodopayments" as const };

        await store.upsertPaymentSession(dodoSession);

        // Dodo answers `refunds.create` with `pending`/`review` and keeps the session `captured`.
        const adapter = fakeAdapter({
            identifier: "dodopayments",
            refundPayment: async () => {
                return { ...dodoSession, pending: true, refundId: "ref_1" };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        const result = await payment.refundPayment({ sessionId: "pay_1" });

        // No money moved yet, so nothing is recorded: a later `refund.failed` maps to `unhandled` and
        // reverses nothing, which would leave an optimistic write over-stating the row forever.
        expect(result.refundedAmount.minorUnits).toBe(0n);
        expect(result.state).toBe("captured");

        const afterIssue = await store.getPaymentSession("dodopayments", "pay_1");

        expect(afterIssue?.refundedAmount.minorUnits).toBe(0n);

        // And no marker was left either, so the confirming `refund.succeeded` still carries the money.
        await applyWebhookAction(store, {
            amount: money(1000, "USD"),
            eventId: "evt_a",
            provider: "dodopayments",
            refundId: "ref_1",
            sessionId: "pay_1",
            type: "payment.refunded",
        });

        const afterWebhook = await store.getPaymentSession("dodopayments", "pay_1");

        expect(afterWebhook?.refundedAmount.minorUnits).toBe(1000n);
        expect(afterWebhook?.state).toBe("refunded");
    });

    it("derives a distinct refund idempotency key per amount so partial refunds don't collide", async () => {
        expect.assertions(3);

        const keys: string[] = [];
        const store = new MemoryPaymentStore();

        await store.upsertPaymentSession(paymentSession("user_1"));

        const adapter = fakeAdapter({
            refundPayment: async (input) => {
                keys.push(input.idempotencyKey ?? "");

                return { ...paymentSession("user_1"), referenceId: "", refundedAmount: input.amount ?? money(1000, "USD"), state: "refunded" };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        await payment.refundPayment({ amount: money(300, "USD"), sessionId: "pi_1" });
        await payment.refundPayment({ amount: money(400, "USD"), sessionId: "pi_1" });
        await payment.refundPayment({ amount: money(300, "USD"), sessionId: "pi_1" });

        // Two different partial refunds of one session must not reuse a key (the provider rejects a
        // reused key with different parameters), and a genuine retry of the same one must.
        expect(keys[0]).not.toBe(keys[1]);
        expect(keys[0]).toBe(keys[2]);
        expect(keys[0]).toMatch(/^refund_payment:stripe:[0-9a-f]{64}$/);
    });

    it("rejects an over-refund before the provider is called", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertPaymentSession(paymentSession("user_1"));

        let called = false;
        const adapter = fakeAdapter({
            refundPayment: async () => {
                called = true;

                return paymentSession("user_1");
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        await expect(payment.refundPayment({ amount: money(2000, "USD"), sessionId: "pi_1" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        // Nothing was issued — a refund the ledger can't record must not reach the provider.
        expect(called).toBe(false);
    });

    it("collapses a refund on another reference's session to NOT_FOUND (no existence oracle)", async () => {
        expect.assertions(1);

        const store = new MemoryPaymentStore();

        await store.upsertPaymentSession(paymentSession("user_2"));

        const payment = createPayment({ adapter: fakeAdapter(), authorize: (referenceId) => referenceId === "user_1", store });

        // NOT_FOUND, not FORBIDDEN — indistinguishable from a genuinely missing session.
        await expect(payment.refundPayment({ sessionId: "pi_1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("rejects a refund on a session neither the store nor the provider knows", async () => {
        expect.assertions(1);

        const payment = createPayment({ adapter: fakeAdapter(), authorize: () => true, store: new MemoryPaymentStore() });

        await expect(payment.refundPayment({ sessionId: "pi_absent" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("falls back to the provider for a session the webhook hasn't created a row for yet", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();
        // Authorize-then-capture inside one request: the row only exists after the webhook lands, so
        // the facade has to ask the provider rather than 404 a payment that plainly exists.
        const adapter = fakeAdapter({
            capturePayment: async () => {
                return { ...paymentSession("user_1"), referenceId: "" };
            },
            getPaymentStatus: async () => {
                return { ...paymentSession("user_1"), capturedAmount: money(0, "USD"), state: "authorized" };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        const captured = await payment.capturePayment({ sessionId: "pi_1" });

        expect(captured.state).toBe("captured");
        expect(captured.capturedAmount.minorUnits).toBe(1000n);
        // The reference survives from the provider-fetched session, not the adapter's blank result.
        await expect(store.getPaymentSession("stripe", "pi_1")).resolves.toMatchObject({ referenceId: "user_1" });
    });

    it("refuses a session carrying no reference to authorize against", async () => {
        expect.assertions(1);

        const adapter = fakeAdapter({
            getPaymentStatus: async () => {
                return { ...paymentSession(""), state: "authorized" };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store: new MemoryPaymentStore() });

        await expect(payment.capturePayment({ sessionId: "pi_1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("captures an owned session through the facade and syncs the store", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();

        await store.upsertPaymentSession({ ...paymentSession("user_1"), capturedAmount: money(0, "USD"), state: "authorized" });

        let forwardedKey: string | undefined;
        const adapter = fakeAdapter({
            capturePayment: async (input) => {
                forwardedKey = input.idempotencyKey;

                // Stripe's `intentToSession` blanks the reference for a checkout-originated intent.
                return { ...paymentSession("user_1"), referenceId: "" };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        await payment.capturePayment({ sessionId: "pi_1" });

        expect(forwardedKey).toMatch(/^capture_payment:stripe:[0-9a-f]{64}$/);
        await expect(store.getPaymentSession("stripe", "pi_1")).resolves.toMatchObject({ referenceId: "user_1", state: "captured" });

        const stored = await store.getPaymentSession("stripe", "pi_1");

        expect(stored?.capturedAmount.minorUnits).toBe(1000n);
    });

    it("derives a distinct capture idempotency key per amount so partial captures don't collide", async () => {
        expect.assertions(4);

        const keys: string[] = [];
        const store = new MemoryPaymentStore();

        await store.upsertPaymentSession({ ...paymentSession("user_1"), capturedAmount: money(0, "USD"), state: "authorized" });

        const adapter = fakeAdapter({
            capturePayment: async (input) => {
                keys.push(input.idempotencyKey ?? "");

                return { ...paymentSession("user_1"), capturedAmount: input.amount ?? money(1000, "USD"), referenceId: "" };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        await payment.capturePayment({ amount: money(300, "USD"), sessionId: "pi_1" });
        await payment.capturePayment({ amount: money(700, "USD"), sessionId: "pi_1" });
        await payment.capturePayment({ amount: money(300, "USD"), sessionId: "pi_1" });
        // No amount at all ("full") is a fourth, distinct request shape.
        await payment.capturePayment({ sessionId: "pi_1" });

        // Two partial captures on one authorization ($300 then $700) sharing a key makes the provider
        // replay the first and silently never collect the second.
        expect(keys[0]).not.toBe(keys[1]);
        expect(keys[0]).toBe(keys[2]);
        expect(keys[3]).not.toBe(keys[0]);
        expect(keys[0]).toMatch(/^capture_payment:stripe:[0-9a-f]{64}$/);
    });

    it("cancels an owned payment through the facade and syncs the store", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();

        await store.upsertPaymentSession({ ...paymentSession("user_1"), capturedAmount: money(0, "USD"), state: "authorized" });

        let forwardedKey: string | undefined;
        const adapter = fakeAdapter({
            cancelPayment: async (_sessionId, cancelOptions) => {
                forwardedKey = cancelOptions?.idempotencyKey;

                return { ...paymentSession("user_1"), amount: money(0, "USD"), capturedAmount: money(0, "USD"), referenceId: "", state: "canceled" };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        await payment.cancelPayment("pi_1");

        expect(forwardedKey).toBe(await derivedIdempotencyKey("cancel_payment", "stripe", "pi_1"));

        const stored = await store.getPaymentSession("stripe", "pi_1");

        expect(stored).toMatchObject({ referenceId: "user_1", state: "canceled" });
        // The authorized amount stands — a cancel establishes the state, not the money.
        expect(stored?.amount.minorUnits).toBe(1000n);
    });

    it("acknowledges a verified webhook with 200 and applies it", async () => {
        expect.assertions(4);

        const store = new MemoryPaymentStore();
        const action: WebhookAction = {
            amount: money(1000, "USD"),
            eventId: "evt_1",
            provider: "stripe",
            referenceId: "user_1",
            sessionId: "pi_1",
            type: "payment.captured",
        };
        // The real body is opaque provider JSON; the adapter normalizes it into the action.
        const payment = createPayment({ adapter: fakeAdapter({ parseWebhook: async () => action }), authorize: () => true, store });

        const response = await payment.handleWebhook(new Request("https://app.test/payment/webhook", { body: "{}", method: "POST" }));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ applied: true, reason: "ok" });

        const session = await store.getPaymentSession("stripe", "pi_1");

        expect(session?.state).toBe("captured");
        expect(session?.capturedAmount.minorUnits).toBe(1000n);
    });

    it("names the reference a subscription event concerns, from the stored subscription, on a redelivery too", async () => {
        expect.assertions(4);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("org_1", "active"));

        const handle = async (action: WebhookAction) => {
            const payment = createPayment({ adapter: fakeAdapter({ parseWebhook: async () => action }), authorize: () => true, store });
            const response = await payment.handleWebhook(new Request("https://app.test/payment/webhook", { body: "{}", method: "POST" }));

            return response.json();
        };

        // A later event for an existing subscription carries only its id.
        await expect(handle({ eventId: "evt_cancel", provider: "stripe", subscriptionId: "sub_1", type: "subscription.canceled" })).resolves.toMatchObject({
            referenceId: "org_1",
        });
        // The provider's retry of the same event is a duplicate, and still names it, so a refresh that failed can finish.
        await expect(handle({ eventId: "evt_cancel", provider: "stripe", subscriptionId: "sub_1", type: "subscription.canceled" })).resolves.toMatchObject({
            applied: false,
            referenceId: "org_1",
        });
        // An event naming another owner reports the owner the stored row kept, not the one it named.
        await expect(
            handle({ eventId: "evt_other", provider: "stripe", referenceId: "org_2", subscriptionId: "sub_1", type: "subscription.active" }),
        ).resolves.toMatchObject({ referenceId: "org_1" });
        // A payment event changes no plan, so it names no reference.
        await expect(
            handle({ amount: money(1000, "USD"), eventId: "evt_pay", provider: "stripe", referenceId: "org_1", sessionId: "pi_1", type: "payment.captured" }),
        ).resolves.not.toHaveProperty("referenceId");
    });

    it("refuses an oversized webhook body with 413 before the adapter parses it", async () => {
        expect.assertions(2);

        const parseWebhook = vi.fn<PaymentAdapter["parseWebhook"]>();
        const payment = createPayment({ adapter: fakeAdapter({ parseWebhook }), authorize: () => true, store: new MemoryPaymentStore() });

        const response = await payment.handleWebhook(
            new Request("https://app.test/payment/webhook", { body: "x".repeat(MAX_WEBHOOK_BODY_BYTES + 1), method: "POST" }),
        );

        expect(response.status).toBe(413);
        expect(parseWebhook).not.toHaveBeenCalled();
    });

    it("returns non-2xx for an orphaned subscription.updated so the provider retries", async () => {
        expect.assertions(2);

        const action: WebhookAction = {
            eventId: "evt_orphan",
            priceId: "price_2",
            provider: "stripe",
            subscriptionId: "sub_absent",
            type: "subscription.updated",
        };
        const payment = createPayment({ adapter: fakeAdapter({ parseWebhook: async () => action }), authorize: () => true, store: new MemoryPaymentStore() });

        const response = await payment.handleWebhook(new Request("https://app.test/payment/webhook", { body: "{}", method: "POST" }));

        // The row this event patches doesn't exist yet — the provider must retry it.
        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({ applied: false, reason: "orphaned" });
    });

    it("carries the orphan 500 through the documented route, which cannot see `handleWebhook`'s Response", async () => {
        expect.assertions(4);

        // The documented wiring: an `httpAction` at the edge forwards the raw body into an
        // `internalAction`, which calls `handleWebhook` inside the shard. Only JSON crosses
        // that `ctx.runAction` hop, so the Response — and the deliberate 500 on an orphaned
        // event — is reconstructed at the edge or lost. It used to be lost: the route
        // answered `Response.json(result)`, every provider saw 200, and the out-of-order
        // event was acknowledged, its claim released, never redelivered.
        const orphan: WebhookAction = {
            eventId: "evt_orphan_route",
            priceId: "price_2",
            provider: "stripe",
            subscriptionId: "sub_absent",
            type: "subscription.updated",
        };
        const accepted: WebhookAction = { eventId: "evt_noop_route", provider: "stripe", type: "unhandled" };

        /** `processWebhook`, exactly as docs / registry / example declare it. */
        const processWebhook = async (action: WebhookAction): Promise<WebhookOutcome> => {
            const payment = createPayment({
                adapter: fakeAdapter({ parseWebhook: async () => action }),
                authorize: () => true,
                store: new MemoryPaymentStore(),
            });
            const response = await payment.handleWebhook(new Request("https://internal/payment/webhook", { body: "{}", method: "POST" }));
            const result: { applied?: boolean } = await response.json();

            return { applied: result.applied ?? false, status: response.status };
        };

        const orphaned = webhookResponse(await processWebhook(orphan));

        expect(orphaned.status).toBe(500);
        await expect(orphaned.json()).resolves.toStrictEqual({ applied: false });

        const acknowledged = webhookResponse(await processWebhook(accepted));

        expect(acknowledged.status).toBe(200);
        await expect(acknowledged.json()).resolves.toStrictEqual({ applied: false });
    });

    it("still acknowledges a genuinely unhandled event with 200", async () => {
        expect.assertions(2);

        const action: WebhookAction = { eventId: "evt_noop", provider: "stripe", type: "unhandled" };
        const payment = createPayment({ adapter: fakeAdapter({ parseWebhook: async () => action }), authorize: () => true, store: new MemoryPaymentStore() });

        const response = await payment.handleWebhook(new Request("https://app.test/payment/webhook", { body: "{}", method: "POST" }));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ applied: false, reason: "unhandled" });
    });

    it("returns the error status when webhook verification fails", async () => {
        expect.assertions(2);

        const adapter = fakeAdapter({
            parseWebhook: async () => {
                throw new LunoraPaymentError("WEBHOOK_SIGNATURE_INVALID", "bad signature");
            },
        });
        const payment = createPayment({ adapter, authorize: () => true, store: new MemoryPaymentStore() });

        const response = await payment.handleWebhook(new Request("https://app.test/payment/webhook", { body: "{}", method: "POST" }));

        expect(response.status).toBe(400);
        // Plan 118: the `LunoraPaymentError` branch now goes through `toErrorBody`
        // rather than reading `.message` directly — pin that a recognized payment
        // error still echoes its own message verbatim (no `PaymentErrorCode` is
        // catalog-marked internal, so this branch never redacts).
        await expect(response.json()).resolves.toEqual({ error: "bad signature" });
    });

    it("preserves a LunoraPaymentError's own status (not hardcoded) through the webhook catch", async () => {
        expect.assertions(2);

        const adapter = fakeAdapter({
            parseWebhook: async () => {
                throw new LunoraPaymentError("PROVIDER_ERROR", "upstream provider timed out");
            },
        });
        const payment = createPayment({ adapter, authorize: () => true, store: new MemoryPaymentStore() });

        const response = await payment.handleWebhook(new Request("https://app.test/payment/webhook", { body: "{}", method: "POST" }));

        // `PROVIDER_ERROR` maps to 502 in `LunoraPaymentError`'s own status map —
        // distinct from `WEBHOOK_SIGNATURE_INVALID`'s 400 above — confirming
        // `toErrorBody`'s status for this branch tracks `error.status`, not a
        // hardcoded literal.
        expect(response.status).toBe(502);
        await expect(response.json()).resolves.toEqual({ error: "upstream provider timed out" });
    });

    it("redacts CONFIG_INVALID's message, which names server-side wiring", async () => {
        expect.assertions(2);

        // `LunoraPaymentError` is a `LunoraError` SUBCLASS, and the catalog gate
        // that keeps every minted code registered could not see subclass mints —
        // so all six payment codes were unregistered, and `isInternalCode` treats
        // an unregistered code as client-safe. This 500 therefore echoed "webhook
        // secret not configured" (and elsewhere the adapter/provider names) to
        // whoever POSTed the webhook. Registered `internal: true`, the status
        // still travels and the message does not.
        const adapter = fakeAdapter({
            parseWebhook: async () => {
                throw new LunoraPaymentError("CONFIG_INVALID", "webhook secret not configured");
            },
        });
        const payment = createPayment({ adapter, authorize: () => true, store: new MemoryPaymentStore() });

        const response = await payment.handleWebhook(new Request("https://app.test/payment/webhook", { body: "{}", method: "POST" }));

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({ error: "Internal error" });
    });

    it("masks an unrecognized webhook-parsing throw behind a generic 400 (unchanged, non-LunoraPaymentError branch)", async () => {
        expect.assertions(2);

        const adapter = fakeAdapter({
            parseWebhook: async () => {
                throw new Error("driver error: connection reset");
            },
        });
        const payment = createPayment({ adapter, authorize: () => true, store: new MemoryPaymentStore() });

        const response = await payment.handleWebhook(new Request("https://app.test/payment/webhook", { body: "{}", method: "POST" }));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({ error: "webhook error" });
    });
});

describe("createPayment — attach / check / track", () => {
    const entitlements = { plans: { pro: { features: ["export"], limits: { api_calls: 100 }, priceIds: ["price_1"] } } };

    const activeSubscription = (referenceId: string): Subscription => {
        return { ...subscription(referenceId, "active"), currentPeriodStart: 1000 };
    };

    it("attach defaults mode to subscription", async () => {
        expect.assertions(1);

        const payment = createPayment({ adapter: fakeAdapter(), authorize: () => true, store: new MemoryPaymentStore() });

        const result = await payment.attach({ cancelUrl: "https://x/cancel", priceId: "price_1", referenceId: "user_1", successUrl: "https://x/ok" });

        expect(result.url).toMatch(/^https:\/\/pay\.test\/checkout:stripe:[0-9a-f]{64}$/);
    });

    it("attach honors an explicit one-time payment mode", async () => {
        expect.assertions(1);

        const payment = createPayment({ adapter: fakeAdapter(), authorize: () => true, store: new MemoryPaymentStore() });

        const result = await payment.attach({
            cancelUrl: "https://x/cancel",
            mode: "payment",
            priceId: "price_1",
            referenceId: "user_1",
            successUrl: "https://x/ok",
        });

        expect(result.url).toMatch(/^https:\/\/pay\.test\/checkout:stripe:[0-9a-f]{64}$/);
    });

    it("check throws when entitlements are not configured", async () => {
        expect.assertions(1);

        const payment = createPayment({ adapter: fakeAdapter(), authorize: () => true, store: new MemoryPaymentStore() });

        await expect(payment.check({ featureId: "export", referenceId: "user_1" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    });

    it("check grants an unlimited boolean feature from an active plan", async () => {
        expect.assertions(1);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(activeSubscription("user_1"));

        const payment = createPayment({ adapter: fakeAdapter(), authorize: () => true, entitlements, store });

        await expect(payment.check({ featureId: "export", referenceId: "user_1" })).resolves.toEqual({ allowed: true, unlimited: true });
    });

    it("check denies a feature no active plan grants", async () => {
        expect.assertions(1);

        const payment = createPayment({ adapter: fakeAdapter(), authorize: () => true, entitlements, store: new MemoryPaymentStore() });

        await expect(payment.check({ featureId: "export", referenceId: "user_1" })).resolves.toEqual({ allowed: false, unlimited: false });
    });

    it("check subtracts tracked usage from a metered limit", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(activeSubscription("user_1"));

        const payment = createPayment({ adapter: fakeAdapter(), authorize: () => true, entitlements, store });

        await payment.track({ featureId: "api_calls", idempotencyKey: "u1", quantity: 30, referenceId: "user_1" });

        await expect(payment.check({ featureId: "api_calls", quantity: 10, referenceId: "user_1" })).resolves.toEqual({
            allowed: true,
            balance: 70,
            limit: 100,
            unlimited: false,
            used: 30,
        });
        await expect(payment.check({ featureId: "api_calls", quantity: 71, referenceId: "user_1" })).resolves.toMatchObject({ allowed: false, balance: 70 });
    });

    it("track rejects a negative / non-integer / null quantity (metered-limit bypass)", async () => {
        expect.assertions(5);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(activeSubscription("user_1"));

        const payment = createPayment({ adapter: fakeAdapter(), authorize: () => true, entitlements, store });

        // A negative delta lands in the append-only ledger, drives the summed
        // period usage below zero, and `balance = limit - used` then hands the
        // reference an unbounded metered allowance past its paid cap.
        await expect(payment.track({ featureId: "api_calls", mode: "add", quantity: -1000, referenceId: "user_1" })).rejects.toMatchObject({
            code: "VALIDATION_ERROR",
        });
        // `mode: "set"` is the same bypass in one call.
        await expect(payment.track({ featureId: "api_calls", mode: "set", quantity: -1, referenceId: "user_1" })).rejects.toMatchObject({
            code: "VALIDATION_ERROR",
        });
        await expect(payment.track({ featureId: "api_calls", quantity: Number.NaN, referenceId: "user_1" })).rejects.toMatchObject({
            code: "VALIDATION_ERROR",
        });
        // An untyped/JSON caller can send `null`; `??` would have quietly defaulted
        // it to 1 instead of rejecting it at the boundary.
        await expect(payment.track({ featureId: "api_calls", quantity: null as unknown as number, referenceId: "user_1" })).rejects.toMatchObject({
            code: "VALIDATION_ERROR",
        });

        // Nothing reached the ledger, so the cap still holds.
        await expect(payment.check({ featureId: "api_calls", quantity: 101, referenceId: "user_1" })).resolves.toMatchObject({ allowed: false });
    });

    it("track records usage exactly once per idempotency key", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();
        const payment = createPayment({ adapter: fakeAdapter({ reportUsage: async () => undefined }), authorize: () => true, store });

        await expect(payment.track({ featureId: "api_calls", idempotencyKey: "u1", quantity: 5, referenceId: "user_1" })).resolves.toEqual({
            recorded: true,
            reportedToProvider: true,
        });
        await expect(payment.track({ featureId: "api_calls", idempotencyKey: "u1", quantity: 5, referenceId: "user_1" })).resolves.toEqual({
            recorded: false,
            reportedToProvider: false,
        });
        await expect(store.sumUsage("user_1", "api_calls", 0)).resolves.toBe(5);
    });

    it("track records locally even when the provider report fails, and observes it", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();
        const events: string[] = [];
        const payment = createPayment({
            adapter: fakeAdapter({
                reportUsage: async () => {
                    throw new Error("provider down");
                },
            }),
            authorize: () => true,
            observability: (event) => events.push(event.type),
            store,
        });

        await expect(payment.track({ featureId: "api_calls", idempotencyKey: "u1", quantity: 5, referenceId: "user_1" })).resolves.toEqual({
            recorded: true,
            reportedToProvider: false,
        });
        expect(events).toContain("usage.report_failed");
        await expect(store.sumUsage("user_1", "api_calls", 0)).resolves.toBe(5);
    });

    it("track skips provider reporting when the adapter has no reportUsage", async () => {
        expect.assertions(1);

        const store = new MemoryPaymentStore();
        const payment = createPayment({ adapter: fakeAdapter({ reportUsage: undefined }), authorize: () => true, store });

        await expect(payment.track({ featureId: "api_calls", idempotencyKey: "u1", quantity: 5, referenceId: "user_1" })).resolves.toEqual({
            recorded: true,
            reportedToProvider: false,
        });
    });

    it("track mode:set reconciles the period total", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(activeSubscription("user_1"));

        const payment = createPayment({ adapter: fakeAdapter({ reportUsage: undefined }), authorize: () => true, entitlements, store });

        await payment.track({ featureId: "api_calls", quantity: 30, referenceId: "user_1" });
        await payment.track({ featureId: "api_calls", mode: "set", quantity: 50, referenceId: "user_1" });

        await expect(payment.check({ featureId: "api_calls", referenceId: "user_1" })).resolves.toMatchObject({ balance: 50, used: 50 });

        // A downward "set" corrects the ledger. It is local-only by construction: `reportUsage` is
        // stripped above because `track` refuses the mode outright where a forward would happen —
        // see "track rejects mode:set on a provider that meters usage upstream".
        await payment.track({ featureId: "api_calls", mode: "set", quantity: 10, referenceId: "user_1" });

        await expect(payment.check({ featureId: "api_calls", referenceId: "user_1" })).resolves.toMatchObject({ balance: 90, used: 10 });

        // Setting to the value it already holds writes nothing.
        await expect(payment.track({ featureId: "api_calls", mode: "set", quantity: 10, referenceId: "user_1" })).resolves.toEqual({
            recorded: false,
            reportedToProvider: false,
        });
    });

    it("track mode:set is race-free — interleaved sets resolve last-writer-wins, not double-applied", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(activeSubscription("user_1"));

        const payment = createPayment({ adapter: fakeAdapter({ reportUsage: undefined }), authorize: () => true, entitlements, store });

        await payment.track({ featureId: "api_calls", quantity: 30, referenceId: "user_1" });

        // Two isolates reconcile the same reference at once. Under the old
        // read-then-append-a-delta scheme both read `used = 30` and both appended
        // their own delta (+20 and +50), landing at 100 — the period double-counted
        // and `balance = limit - used` wrong. Appending the absolute target makes
        // the pair resolve to ONE of the two values instead.
        await Promise.all([
            payment.track({ featureId: "api_calls", mode: "set", quantity: 50, referenceId: "user_1" }),
            payment.track({ featureId: "api_calls", mode: "set", quantity: 80, referenceId: "user_1" }),
        ]);

        const after = await payment.check({ featureId: "api_calls", referenceId: "user_1" });

        expect([50, 80]).toContain(after.used);

        // Replaying a "set" under its own idempotency key is a no-op, and re-issuing
        // the same target is idempotent regardless of what ran in between.
        await payment.track({ featureId: "api_calls", mode: "set", quantity: 80, referenceId: "user_1" });
        await payment.track({ featureId: "api_calls", mode: "set", quantity: 80, referenceId: "user_1" });

        await expect(payment.check({ featureId: "api_calls", referenceId: "user_1" })).resolves.toMatchObject({ balance: 20, used: 80 });
    });

    it("track mode:set discards earlier usage in the period, and later adds accrue on top", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(activeSubscription("user_1"));

        const payment = createPayment({ adapter: fakeAdapter({ reportUsage: undefined }), authorize: () => true, entitlements, store });

        await payment.track({ featureId: "api_calls", quantity: 30, referenceId: "user_1" });
        await payment.track({ featureId: "api_calls", mode: "set", quantity: 5, referenceId: "user_1" });

        // The "set" marker resets the fold: the earlier 30 is discarded, not summed.
        await expect(payment.check({ featureId: "api_calls", referenceId: "user_1" })).resolves.toMatchObject({ used: 5 });

        await payment.track({ featureId: "api_calls", quantity: 7, referenceId: "user_1" });

        // …and an "add" after it accrues on top of the reset total.
        await expect(payment.check({ featureId: "api_calls", referenceId: "user_1" })).resolves.toMatchObject({ used: 12 });
    });

    it("track rejects mode:set on a provider that meters usage upstream", async () => {
        expect.assertions(3);

        // Regression: a provider meter is additive, so a "set" could only be forwarded as the
        // difference from the total just read — and a set that LOWERS usage has no negative delta to
        // send. `set 10 → set 5 → set 8` forwarded 10 then 3, billing 13 upstream against a local
        // period total of 8, and the gap widened on every cycle. Reject the mode rather than over-bill.
        const store = new MemoryPaymentStore();
        const forwarded: number[] = [];

        await store.upsertSubscription(activeSubscription("user_1"));

        const payment = createPayment({
            adapter: fakeAdapter({
                reportUsage: async (input) => {
                    forwarded.push(input.quantity);
                },
            }),
            authorize: () => true,
            entitlements,
            store,
        });

        await expect(payment.track({ featureId: "api_calls", mode: "set", quantity: 10, referenceId: "user_1" })).rejects.toMatchObject({
            code: "VALIDATION_ERROR",
        });

        // Nothing forwarded and nothing recorded — the throw is before the ledger append.
        expect(forwarded).toStrictEqual([]);

        // "add" is exact on both sides and stays available.
        await payment.track({ featureId: "api_calls", quantity: 10, referenceId: "user_1" });

        expect(forwarded).toStrictEqual([10]);
    });

    it("track on a provider without usage metering (Creem-style) records locally only", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();
        const reported: number[] = [];
        const payment = createPayment({
            adapter: fakeAdapter({
                capabilities: { checkoutExpiry: false, merchantOfRecord: true, portal: true, usageMetering: false },
                reportUsage: async (input) => {
                    reported.push(input.quantity);
                },
            }),
            authorize: () => true,
            store,
        });

        await expect(payment.track({ featureId: "api_calls", idempotencyKey: "u1", quantity: 5, referenceId: "user_1" })).resolves.toEqual({
            recorded: true,
            reportedToProvider: false,
        });
        expect(reported).toHaveLength(0);
        await expect(store.sumUsage("user_1", "api_calls", 0)).resolves.toBe(5);
    });

    it("check by priceId answers product access", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(activeSubscription("user_1"));

        const payment = createPayment({ adapter: fakeAdapter(), authorize: () => true, store });

        await expect(payment.check({ priceId: "price_1", referenceId: "user_1" })).resolves.toEqual({ allowed: true, unlimited: false });
        await expect(payment.check({ priceId: "price_absent", referenceId: "user_1" })).resolves.toEqual({ allowed: false, unlimited: false });
    });

    it("check throws when given neither a featureId nor a priceId", async () => {
        expect.assertions(1);

        const payment = createPayment({ adapter: fakeAdapter(), authorize: () => true, entitlements, store: new MemoryPaymentStore() });

        await expect(payment.check({ referenceId: "user_1" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    });

    it("listBalances resolves every configured feature in one call", async () => {
        expect.assertions(1);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(activeSubscription("user_1"));

        const payment = createPayment({ adapter: fakeAdapter(), authorize: () => true, entitlements, store });

        await payment.track({ featureId: "api_calls", quantity: 30, referenceId: "user_1" });

        await expect(payment.listBalances("user_1")).resolves.toEqual([
            { allowed: true, balance: 70, featureId: "api_calls", limit: 100, unlimited: false, used: 30 },
            { allowed: true, featureId: "export", unlimited: true },
        ]);
    });

    it("listBalances issues one batched usage read for all metered features", async () => {
        expect.assertions(3);

        const manyMetered = { plans: { pro: { features: [], limits: { api_calls: 100, exports: 10, seats: 5 }, priceIds: ["price_1"] } } };
        const store = new MemoryPaymentStore();

        await store.upsertSubscription(activeSubscription("user_1"));

        const sumUsage = vi.spyOn(store, "sumUsage");
        const sumUsageByFeature = vi.spyOn(store, "sumUsageByFeature");
        const payment = createPayment({ adapter: fakeAdapter(), authorize: () => true, entitlements: manyMetered, store });

        const balances = await payment.listBalances("user_1");

        expect(balances.map((balance) => balance.featureId)).toEqual(["api_calls", "exports", "seats"]);
        // N metered features cost one batched read, not N per-feature scans.
        expect(sumUsage).not.toHaveBeenCalled();
        expect(sumUsageByFeature).toHaveBeenCalledTimes(1);
    });
});

describe("createPayment — bug-hunt regressions", () => {
    const entitlements = { plans: { pro: { features: ["export"], limits: { api_calls: 100 }, priceIds: ["price_1"] } } };

    const owned = { authorize: (referenceId: string) => referenceId === "user_1" };

    it("windows metered usage on the granting plan, so an unrelated subscription's fresh period does not reset it", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription({ ...subscription("user_1", "active"), currentPeriodStart: 1000 });

        const payment = createPayment({ adapter: fakeAdapter({ reportUsage: undefined }), authorize: () => true, entitlements, store });

        await payment.track({ featureId: "api_calls", quantity: 30, referenceId: "user_1" });
        // An add-on bought later — it grants nothing metered, and its period starts after the usage.
        await store.upsertSubscription({
            ...subscription("user_1", "active"),
            currentPeriodStart: Date.now() + 1_000_000,
            id: "sub_addon",
            priceId: "price_addon",
        });

        await expect(payment.check({ featureId: "api_calls", referenceId: "user_1" })).resolves.toMatchObject({ used: 30 });
        await expect(payment.listBalances("user_1")).resolves.toContainEqual(expect.objectContaining({ featureId: "api_calls", used: 30 }));
    });

    it("check rejects a negative / non-integer quantity like track does", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription({ ...subscription("user_1", "active"), currentPeriodStart: 1000 });

        const payment = createPayment({ adapter: fakeAdapter(), authorize: () => true, entitlements, store });

        await payment.track({ featureId: "api_calls", quantity: 150, referenceId: "user_1" });

        // Over the cap, a negative `need` made `balance >= need` true.
        await expect(payment.check({ featureId: "api_calls", quantity: -100, referenceId: "user_1" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await expect(payment.check({ featureId: "api_calls", quantity: 0.5, referenceId: "user_1" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    });

    it("namespaces a caller's track key per reference, so one tenant cannot claim another's", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();
        const payment = createPayment({ adapter: fakeAdapter({ reportUsage: undefined }), authorize: () => true, store });

        await expect(payment.track({ featureId: "api_calls", idempotencyKey: "k1", quantity: 5, referenceId: "user_a" })).resolves.toMatchObject({
            recorded: true,
        });
        await expect(payment.track({ featureId: "api_calls", idempotencyKey: "k1", quantity: 7, referenceId: "user_b" })).resolves.toMatchObject({
            recorded: true,
        });
        await expect(store.sumUsage("user_b", "api_calls", 0)).resolves.toBe(7);
    });

    it("namespaces a caller's checkout key per reference before it reaches the provider", async () => {
        expect.assertions(2);

        const keys: string[] = [];
        const payment = createPayment({
            adapter: fakeAdapter({
                createCheckout: async (input) => {
                    keys.push(input.idempotencyKey ?? "");

                    return { id: "cs_1", provider: "stripe", url: "https://pay.test" };
                },
            }),
            authorize: () => true,
            store: new MemoryPaymentStore(),
        });
        const checkout = { idempotencyKey: "k1", mode: "payment", priceId: "price_1", successUrl: "https://x/ok" } as const;

        await payment.createCheckout({ ...checkout, referenceId: "user_a" });
        await payment.createCheckout({ ...checkout, referenceId: "user_b" });

        expect(keys[0]).not.toBe("k1");
        expect(keys[0]).not.toBe(keys[1]);
    });

    it("keys a subscription cancel by mode and by the row's version", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();
        const keys: string[] = [];
        const adapter = fakeAdapter({
            cancelSubscription: async (id, cancelOptions) => {
                keys.push(cancelOptions?.idempotencyKey ?? "");

                return { ...subscription("user_1", "active"), cancelAtPeriodEnd: true, id };
            },
        });
        const payment = createPayment({ adapter, ...owned, store });

        await store.upsertSubscription(subscription("user_1", "active"));
        await payment.cancelSubscription("sub_1", { atPeriodEnd: true });
        await store.upsertSubscription(subscription("user_1", "active"));
        await payment.cancelSubscription("sub_1");
        // Resumed (a later write moved `updatedAt`), then cancelled at period end again.
        await store.upsertSubscription({ ...subscription("user_1", "active"), updatedAt: 50 });
        await payment.cancelSubscription("sub_1", { atPeriodEnd: true });

        expect(keys[0]).not.toBe(keys[1]);
        expect(keys[0]).not.toBe(keys[2]);
        expect(keys[0]).toBe(await derivedIdempotencyKey("cancel_subscription", "stripe", "sub_1", "period_end", 0));
    });

    it("returns a subscription already in the requested end state without calling the provider", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();
        let calls = 0;
        const adapter = fakeAdapter({
            cancelSubscription: async (id, cancelOptions) => {
                calls += 1;

                return cancelOptions?.atPeriodEnd
                    ? { ...subscription("user_1", "active"), cancelAtPeriodEnd: true, id, updatedAt: 10 }
                    : { ...subscription("user_1", "canceled"), id, updatedAt: 20 };
            },
        });
        const payment = createPayment({ adapter, ...owned, store });

        await store.upsertSubscription(subscription("user_1", "active"));
        await payment.cancelSubscription("sub_1", { atPeriodEnd: true });
        // A client retry after the first cancel succeeded: the row's `updatedAt` moved, so a new key.
        await payment.cancelSubscription("sub_1", { atPeriodEnd: true });

        expect(calls).toBe(1);

        await payment.cancelSubscription("sub_1");

        await expect(payment.cancelSubscription("sub_1")).resolves.toMatchObject({ state: "canceled" });

        expect(calls).toBe(2);
    });

    it("books a refund onto the row as it is after the provider call, keeping a concurrent refund", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertPaymentSession(paymentSession("user_1"));

        const adapter = fakeAdapter({
            identifier: "stripe",
            refundPayment: async (input) => {
                // A second refund of 30 lands while the provider is answering this one.
                await store.upsertPaymentSession({ ...paymentSession("user_1"), refundedAmount: money(30, "USD"), state: "partially_refunded" });

                return { ...paymentSession("user_1"), refundedAmount: input.amount ?? money(1000, "USD"), refundId: `re_${String(input.amount?.minorUnits)}` };
            },
        });
        const payment = createPayment({ adapter, ...owned, store });

        await payment.refundPayment({ amount: money(40, "USD"), sessionId: "pi_1" });

        const stored = await store.getPaymentSession("stripe", "pi_1");

        expect(stored?.refundedAmount.minorUnits).toBe(70n);
        expect(stored?.state).toBe("partially_refunded");
    });

    it("takes an absolute provider's cumulative total instead of adding to a row its webhook already booked", async () => {
        expect.assertions(1);

        const store = new MemoryPaymentStore();

        await store.upsertPaymentSession(paymentSession("user_1"));

        const adapter = fakeAdapter({
            refundPayment: async () => {
                // `charge.refunded` (cumulative 30, THIS refund) lands mid-call.
                await store.upsertPaymentSession({ ...paymentSession("user_1"), refundedAmount: money(30, "USD"), state: "partially_refunded" });

                return { ...paymentSession("user_1"), refundedTotal: money(30, "USD"), refundId: "re_1" };
            },
        });
        const payment = createPayment({ adapter, ...owned, store });

        await payment.refundPayment({ amount: money(30, "USD"), sessionId: "pi_1" });

        await expect(store.getPaymentSession("stripe", "pi_1")).resolves.toMatchObject({ refundedAmount: money(30, "USD") });
    });

    it("acknowledges a stale subscription event with 200 and leaves the row alone", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();
        const payment = createPayment({ adapter: fakeAdapter(), authorize: () => true, store });
        const deliver = async (action: Partial<WebhookAction>): Promise<Response> =>
            payment.handleWebhook(
                new Request("https://x/webhook", {
                    body: JSON.stringify({ provider: "stripe", referenceId: "user_1", subscriptionId: "sub_1", ...action }),
                    method: "POST",
                }),
            );

        await deliver({ eventId: "e1", occurredAt: 1000, type: "subscription.active" });
        await deliver({ eventId: "e2", occurredAt: 3000, type: "subscription.past_due" });

        // The earlier `active`, redelivered after a 5xx.
        const response = await deliver({ eventId: "e3", occurredAt: 2000, type: "subscription.active" });

        expect(response.status).toBe(200);
        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ state: "past_due" });
    });
});

describe("createPayment — updateSubscription / resumeSubscription", () => {
    it("answers an unknown id and another caller's subscription with the same NOT_FOUND, without calling the provider", async () => {
        expect.assertions(6);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_2", "active"));

        const updateSubscription = vi.fn<PaymentAdapter["updateSubscription"]>(fakeAdapter().updateSubscription);
        const resumeSubscription = vi.fn<PaymentAdapter["resumeSubscription"]>(fakeAdapter().resumeSubscription);
        const payment = createPayment({
            adapter: fakeAdapter({ resumeSubscription, updateSubscription }),
            authorize: (referenceId) => referenceId === "user_1",
            store,
        });

        await expect(payment.updateSubscription("sub_1", { priceId: "price_2" })).rejects.toMatchObject({
            code: "NOT_FOUND",
            message: `subscription "sub_1" not found`,
        });
        await expect(payment.resumeSubscription("sub_absent")).rejects.toMatchObject({
            code: "NOT_FOUND",
            message: `subscription "sub_absent" not found`,
        });
        expect(updateSubscription).not.toHaveBeenCalled();
        expect(resumeSubscription).not.toHaveBeenCalled();
        await expect(payment.updateSubscription("sub_absent", { priceId: "price_2" })).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(payment.resumeSubscription("sub_1")).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("changes the owner's plan through the provider and stores the answer", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_1", "active"));

        // The provider's current state is what the row is settled to, so the status read reports the new plan.
        const adapter = fakeAdapter({
            getSubscriptionStatus: async (id) => {
                return { ...subscription("user_1", "active"), id, priceId: "price_2" };
            },
            updateSubscription: async (id, patch) => {
                return { ...subscription("user_1", "active"), id, priceId: patch.priceId ?? "price_1" };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        await expect(payment.updateSubscription("sub_1", { priceId: "price_2" })).resolves.toMatchObject({ priceId: "price_2" });
        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ priceId: "price_2" });
    });

    it("forwards no idempotency key without a caller key, and a namespaced one with it", async () => {
        expect.assertions(4);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_1", "active"));

        const received: (string | undefined)[] = [];
        const adapter = fakeAdapter({
            resumeSubscription: async (id, options) => {
                received.push(options?.idempotencyKey);

                return { ...subscription("user_1", "active"), id };
            },
            updateSubscription: async (id, patch) => {
                received.push(patch.idempotencyKey);

                return { ...subscription("user_1", "active"), id };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        await payment.updateSubscription("sub_1", { priceId: "price_2" });
        await payment.resumeSubscription("sub_1");
        await payment.updateSubscription("sub_1", { idempotencyKey: "k1", priceId: "price_2" });
        await payment.resumeSubscription("sub_1", { idempotencyKey: "k1" });

        expect(received[0]).toBeUndefined();
        expect(received[1]).toBeUndefined();
        expect(received[2]).toBe(await derivedIdempotencyKey("update_subscription", "stripe", "sub_1", "k1"));
        expect(received[3]).toBe(await derivedIdempotencyKey("resume_subscription", "stripe", "sub_1", "k1"));
    });

    it("refuses an invalid seat count before the provider is called", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_1", "active"));

        const updateSubscription = vi.fn<PaymentAdapter["updateSubscription"]>(fakeAdapter().updateSubscription);
        const payment = createPayment({
            adapter: fakeAdapter({ updateSubscription }),
            authorize: (referenceId) => referenceId === "user_1",
            store,
        });

        await expect(payment.updateSubscription("sub_1", { quantity: -1 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(updateSubscription).not.toHaveBeenCalled();
    });

    it("undoes a period-end cancel with resume, and a later period-end cancel is sent to the provider again", async () => {
        expect.assertions(4);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_1", "active"));

        const cancelSubscription = vi.fn<PaymentAdapter["cancelSubscription"]>(async (id, options) => {
            return { ...subscription("user_1", "active"), cancelAtPeriodEnd: options?.atPeriodEnd === true, id };
        });
        const adapter = fakeAdapter({
            cancelSubscription,
            resumeSubscription: async (id) => {
                return { ...subscription("user_1", "active"), cancelAtPeriodEnd: false, id };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        await payment.cancelSubscription("sub_1", { atPeriodEnd: true });

        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ cancelAtPeriodEnd: true });

        await payment.resumeSubscription("sub_1");

        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ cancelAtPeriodEnd: false });

        await payment.cancelSubscription("sub_1", { atPeriodEnd: true });

        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ cancelAtPeriodEnd: true });
        expect(cancelSubscription).toHaveBeenCalledTimes(2);
    });

    it("refuses a resume the single-subscription policy blocks before the provider is called", async () => {
        expect.assertions(4);

        const store = new MemoryPaymentStore();
        const observer = vi.fn<PaymentObserver>();
        const resumeSubscription = vi.fn<PaymentAdapter["resumeSubscription"]>(async (id) => {
            return { ...subscription("user_1", "active"), id };
        });

        await store.upsertSubscription({ ...subscription("user_1", "active"), id: "sub_2" });
        await store.upsertSubscription(subscription("user_1", "paused"));

        const payment = createPayment({
            adapter: fakeAdapter({ resumeSubscription }),
            authorize: (referenceId) => referenceId === "user_1",
            observability: observer,
            singleSubscriptionPerReference: true,
            store,
        });

        await expect(payment.resumeSubscription("sub_1")).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
        expect(resumeSubscription).not.toHaveBeenCalled();
        expect(observer).toHaveBeenCalledWith(expect.objectContaining({ subscriptionId: "sub_1", type: "subscription.duplicate" }));
        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ state: "paused" });
    });

    it("lets a resume of a row that already grants access through, since it adds no access", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription({ ...subscription("user_1", "active"), id: "sub_2" });
        await store.upsertSubscription(subscription("user_1", "active"));

        const resumeSubscription = vi.fn<PaymentAdapter["resumeSubscription"]>(async (id) => {
            return { ...subscription("user_1", "active"), id };
        });
        const payment = createPayment({
            adapter: fakeAdapter({ resumeSubscription }),
            authorize: (referenceId) => referenceId === "user_1",
            singleSubscriptionPerReference: true,
            store,
        });

        await expect(payment.resumeSubscription("sub_1")).resolves.toMatchObject({ id: "sub_1", state: "active" });
        expect(resumeSubscription).toHaveBeenCalledTimes(1);
    });

    it("records a provider plan change that moves to a new id, and retires the old row", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_1", "active"));

        // Autumn names a plan change by its new `customer::product` id, so no row exists under the old revision's id.
        const adapter = fakeAdapter({
            getSubscriptionStatus: async () => {
                return { ...subscription("user_1", "active"), id: "sub_2", priceId: "price_2" };
            },
            updateSubscription: async (_id, patch) => {
                return { ...subscription("user_1", "active"), id: "sub_2", priceId: patch.priceId ?? "price_1" };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        await expect(payment.updateSubscription("sub_1", { priceId: "price_2" })).resolves.toMatchObject({ id: "sub_2", priceId: "price_2" });
        await expect(store.getSubscription("stripe", "sub_2")).resolves.toMatchObject({ priceId: "price_2", state: "active" });
        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ state: "canceled" });
    });

    it("refuses a keyed plan change retried under a key already claimed, without calling the provider again", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_1", "active"));

        const updateSubscription = vi.fn<PaymentAdapter["updateSubscription"]>(async (id, patch) => {
            return {
                ...subscription("user_1", "active"),
                id,
                priceId: patch.priceId ?? "price_1",
            };
        });
        const payment = createPayment({
            adapter: fakeAdapter({ updateSubscription }),
            authorize: (referenceId) => referenceId === "user_1",
            store,
        });

        await payment.updateSubscription("sub_1", { idempotencyKey: "change-1", priceId: "price_2" });

        await expect(payment.updateSubscription("sub_1", { idempotencyKey: "change-1", priceId: "price_2" })).rejects.toMatchObject({
            code: "INVALID_TRANSITION",
        });
        expect(updateSubscription).toHaveBeenCalledTimes(1);
    });

    it("does not call the provider again under a key whose first attempt failed, since its outcome is unknown", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_1", "paused"));

        const resumeSubscription = vi.fn<PaymentAdapter["resumeSubscription"]>(async () => {
            throw new Error("provider timed out");
        });
        const payment = createPayment({
            adapter: fakeAdapter({ resumeSubscription }),
            authorize: (referenceId) => referenceId === "user_1",
            store,
        });

        await expect(payment.resumeSubscription("sub_1", { idempotencyKey: "resume-1" })).rejects.toThrow("provider timed out");
        await expect(payment.resumeSubscription("sub_1", { idempotencyKey: "resume-1" })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
        expect(resumeSubscription).toHaveBeenCalledTimes(1);
    });

    it("forwards unkeyed plan changes each time, since they are new requests", async () => {
        expect.assertions(1);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_1", "active"));

        const updateSubscription = vi.fn<PaymentAdapter["updateSubscription"]>(async (id) => {
            return { ...subscription("user_1", "active"), id };
        });
        const payment = createPayment({
            adapter: fakeAdapter({ updateSubscription }),
            authorize: (referenceId) => referenceId === "user_1",
            store,
        });

        await payment.updateSubscription("sub_1", { priceId: "price_2" });
        await payment.updateSubscription("sub_1", { priceId: "price_2" });

        expect(updateSubscription).toHaveBeenCalledTimes(2);
    });

    it("gives a moved subscription the creation date of the plan it lands on, not the one it left", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription({ ...subscription("user_1", "active"), createdAt: 100 });

        const adapter = fakeAdapter({
            getSubscriptionStatus: async () => {
                return { ...subscription("user_1", "active"), createdAt: 500, id: "sub_2", priceId: "price_2" };
            },
            updateSubscription: async () => {
                return { ...subscription("user_1", "active"), createdAt: 500, id: "sub_2", priceId: "price_2" };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        await expect(payment.updateSubscription("sub_1", { priceId: "price_2" })).resolves.toMatchObject({ createdAt: 500, id: "sub_2" });
        await expect(store.getSubscription("stripe", "sub_2")).resolves.toMatchObject({ createdAt: 500, referenceId: "user_1" });
    });

    it("returns to a plan whose row an earlier change canceled, replacing that row", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_1", "active"));
        await store.upsertSubscription({ ...subscription("user_1", "canceled"), id: "sub_2", priceId: "price_2" });

        const adapter = fakeAdapter({
            getSubscriptionStatus: async () => {
                return { ...subscription("user_1", "active"), id: "sub_2", priceId: "price_2" };
            },
            updateSubscription: async (_id, patch) => {
                return { ...subscription("user_1", "active"), id: "sub_2", priceId: patch.priceId ?? "price_2" };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        await expect(payment.updateSubscription("sub_1", { priceId: "price_2" })).resolves.toMatchObject({ id: "sub_2", state: "active" });
        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ state: "canceled" });
    });

    it("keeps the old plan active when a downgrade lands the new one paused", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_1", "active"));

        const adapter = fakeAdapter({
            getSubscriptionStatus: async () => {
                return { ...subscription("user_1", "paused"), id: "sub_2", priceId: "price_2" };
            },
            updateSubscription: async (_id, patch) => {
                return { ...subscription("user_1", "paused"), id: "sub_2", priceId: patch.priceId ?? "price_2" };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        await payment.updateSubscription("sub_1", { priceId: "price_2" });

        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ state: "active" });
        await expect(store.getSubscription("stripe", "sub_2")).resolves.toMatchObject({ state: "paused" });
    });

    it("refuses a plan change whose destination a webhook wrote while the provider's state was read", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_1", "active"));

        // The provider's state is read after a webhook wrote the destination, so the snapshot is older than the row.
        const adapter = fakeAdapter({
            getSubscriptionStatus: async () => {
                await store.upsertSubscription({ ...subscription("user_1", "active"), id: "sub_2", priceId: "price_webhook" });

                return { ...subscription("user_1", "active"), id: "sub_2", priceId: "price_2" };
            },
            updateSubscription: async (_id, patch) => {
                return { ...subscription("user_1", "active"), id: "sub_2", priceId: patch.priceId ?? "price_2" };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        await expect(payment.updateSubscription("sub_1", { priceId: "price_2" })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
        await expect(store.getSubscription("stripe", "sub_2")).resolves.toMatchObject({ priceId: "price_webhook" });
    });

    it("records the provider's answer when reading its current state fails, so a completed change is not lost", async () => {
        expect.assertions(1);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_1", "active"));

        const adapter = fakeAdapter({
            getSubscriptionStatus: () => Promise.reject(new Error("provider read unavailable")),
            updateSubscription: async (id, patch) => {
                return { ...subscription("user_1", "active"), id, priceId: patch.priceId ?? "price_2" };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        await payment.updateSubscription("sub_1", { priceId: "price_2" });

        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ priceId: "price_2" });
    });

    it("settles the row to the provider's current state, not a replayed answer", async () => {
        expect.assertions(1);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_1", "active"));

        // The retry comes back as the first call's cached answer (price_2) while the provider already sits on price_3.
        const adapter = fakeAdapter({
            getSubscriptionStatus: async (id) => {
                return { ...subscription("user_1", "active"), id, priceId: "price_3" };
            },
            updateSubscription: async (id) => {
                return { ...subscription("user_1", "active"), id, priceId: "price_2" };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        await payment.updateSubscription("sub_1", { priceId: "price_2" });

        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ priceId: "price_3" });
    });

    it("refuses an empty plan id, a seat cut to zero, and a row with no owner", async () => {
        expect.assertions(4);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_1", "active"));
        await store.upsertSubscription({ ...subscription("", "active"), id: "sub_orphan" });

        const updateSubscription = vi.fn<PaymentAdapter["updateSubscription"]>(fakeAdapter().updateSubscription);
        // An application authorizer that accepts a blank reference: the ownerless row must still be refused on its own.
        const payment = createPayment({
            adapter: fakeAdapter({ updateSubscription }),
            authorize: () => true,
            store,
        });

        await expect(payment.updateSubscription("sub_1", { priceId: "  " })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await expect(payment.updateSubscription("sub_1", { quantity: 0 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await expect(payment.updateSubscription("sub_orphan", { priceId: "price_2" })).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(updateSubscription).not.toHaveBeenCalled();
    });

    it("gives the old plan back when the new row's write fails outright, and surfaces the error", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_1", "active"));

        // The store fails the destination write itself, not a guard: the old row was already retired by then.
        const failing = Object.assign(Object.create(store) as object, {
            upsertSubscription: (record: Subscription, guard?: RevisionGuard) => {
                if (record.id === "sub_2") {
                    return Promise.reject(new Error("database unavailable"));
                }

                return store.upsertSubscription(record, guard);
            },
        }) as PaymentStore;

        const adapter = fakeAdapter({
            getSubscriptionStatus: async () => {
                return { ...subscription("user_1", "active"), id: "sub_2", priceId: "price_2" };
            },
            updateSubscription: async (_id, patch) => {
                return { ...subscription("user_1", "active"), id: "sub_2", priceId: patch.priceId ?? "price_2" };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store: failing });

        await expect(payment.updateSubscription("sub_1", { priceId: "price_2" })).rejects.toThrow("database unavailable");
        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ state: "active" });
    });

    it("reports a failed restore with both failures, so the subscription can be reconciled", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_1", "active"));

        // The new row's write fails, and the restore of the old row fails too.
        let oldRowWrites = 0;
        const failing = Object.assign(Object.create(store) as object, {
            upsertSubscription: (record: Subscription, guard?: RevisionGuard) => {
                if (record.id === "sub_2") {
                    return Promise.reject(new Error("database unavailable"));
                }

                if (record.id === "sub_1") {
                    oldRowWrites += 1;

                    if (oldRowWrites > 1) {
                        return Promise.reject(new Error("restore unavailable"));
                    }
                }

                return store.upsertSubscription(record, guard);
            },
        }) as PaymentStore;

        const adapter = fakeAdapter({
            getSubscriptionStatus: async () => {
                return { ...subscription("user_1", "active"), id: "sub_2", priceId: "price_2" };
            },
            updateSubscription: async (_id, patch) => {
                return { ...subscription("user_1", "active"), id: "sub_2", priceId: patch.priceId ?? "price_2" };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store: failing });

        const failure = await payment.updateSubscription("sub_1", { priceId: "price_2" }).catch((error: unknown) => error);

        expect(failure).toMatchObject({ code: "INVALID_TRANSITION" });
        // The message goes to the caller, so it names neither storage failure; both are kept on the cause for the operator.
        expect((failure as Error).message).not.toMatch(/database unavailable|restore unavailable/u);
        expect((failure as Error & { cause: { restoreError: Error; storeError: Error } }).cause).toMatchObject({
            restoreError: { message: "restore unavailable" },
            storeError: { message: "database unavailable" },
        });
    });

    it("keeps the stored add-on prices when a plan change's status read fails and the answer omits the price set", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription({ ...subscription("user_1", "active"), priceIds: ["price_1", "addon_1"] });

        // The change answers with the first page of items only (no full price set), and the follow-up status read fails.
        const adapter = fakeAdapter({
            getSubscriptionStatus: () => Promise.reject(new Error("provider read unavailable")),
            updateSubscription: async (id, patch) => {
                return { ...subscription("user_1", "active"), id, priceId: patch.priceId ?? "price_1" };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        await payment.updateSubscription("sub_1", { priceId: "price_2" });

        const stored = await store.getSubscription("stripe", "sub_1");

        expect(stored).toMatchObject({ priceId: "price_2" });
        expect(stored?.priceIds).toStrictEqual(["price_2", "addon_1"]);
    });

    it("keeps the stored seat count when a plan change's status read fails and the answer reports one seat", async () => {
        expect.assertions(1);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription({ ...subscription("user_1", "active"), quantity: 5 });

        // The upgrade answer omits item units, which the adapter maps to one, and the follow-up status read fails.
        const adapter = fakeAdapter({
            getSubscriptionStatus: () => Promise.reject(new Error("provider read unavailable")),
            updateSubscription: async (id, patch) => {
                return { ...subscription("user_1", "active"), id, priceId: patch.priceId ?? "price_1", quantity: 1 };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        await payment.updateSubscription("sub_1", { priceId: "price_2" });

        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ priceId: "price_2", quantity: 5 });
    });

    it("refuses to resume or change a canceled subscription without calling the provider", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_1", "canceled"));

        const resumeSubscription = vi.fn<PaymentAdapter["resumeSubscription"]>();
        const updateSubscription = vi.fn<PaymentAdapter["updateSubscription"]>();
        const payment = createPayment({ adapter: fakeAdapter({ resumeSubscription, updateSubscription }), authorize: () => true, store });

        await expect(payment.resumeSubscription("sub_1")).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
        await expect(payment.updateSubscription("sub_1", { priceId: "price_2" })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
        expect([...resumeSubscription.mock.calls, ...updateSubscription.mock.calls]).toHaveLength(0);
    });

    it("records a resume as no longer cancelling even when the provider's status read still reports it", async () => {
        expect.assertions(1);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription({ ...subscription("user_1", "active"), cancelAtPeriodEnd: true });

        // The uncancel landed, but the re-read derives the flag from a cancel timestamp that trails it.
        const adapter = fakeAdapter({
            getSubscriptionStatus: async (id) => {
                return { ...subscription("user_1", "active"), cancelAtPeriodEnd: true, id };
            },
            resumeSubscription: async (id) => {
                return { ...subscription("user_1", "active"), cancelAtPeriodEnd: false, id };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        await expect(payment.resumeSubscription("sub_1")).resolves.toMatchObject({ cancelAtPeriodEnd: false });
    });

    it("drops a webhook created before a plan change that arrives after it", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription({ ...subscription("user_1", "active"), lastEventAt: 1000 });

        const adapter = fakeAdapter({
            getSubscriptionStatus: async (id) => {
                return { ...subscription("user_1", "active"), id, priceId: "price_2" };
            },
            updateSubscription: async (id) => {
                return { ...subscription("user_1", "active"), id, priceId: "price_2" };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store });

        const requestedAt = Date.now();

        await payment.updateSubscription("sub_1", { priceId: "price_2" });

        // Created at the provider before the change was requested, newer than the last event the row had applied.
        const outcome = await applyWebhookAction(store, {
            eventId: "evt_late",
            occurredAt: requestedAt - 1,
            provider: "stripe",
            subscriptionId: "sub_1",
            type: "subscription.past_due",
        });

        expect(outcome).toStrictEqual({ applied: false, reason: "stale" });
        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ priceId: "price_2", state: "active" });
    });

    it("leaves the old plan retired when the provider's event wrote the new plan as canceled during the change", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_1", "active"));

        // The new plan's cancellation webhook lands between the retire and the guarded destination write.
        const racing = Object.assign(Object.create(store) as object, {
            upsertSubscription: async (record: Subscription, guard?: RevisionGuard) => {
                if (record.id === "sub_2" && guard !== undefined) {
                    await store.upsertSubscription({ ...subscription("user_1", "canceled"), id: "sub_2" });
                }

                return store.upsertSubscription(record, guard);
            },
        }) as PaymentStore;

        const adapter = fakeAdapter({
            getSubscriptionStatus: async () => {
                return { ...subscription("user_1", "active"), id: "sub_2", priceId: "price_2" };
            },
            updateSubscription: async () => {
                return { ...subscription("user_1", "active"), id: "sub_2", priceId: "price_2" };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store: racing });

        await expect(payment.updateSubscription("sub_1", { priceId: "price_2" })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ state: "canceled" });
    });

    it("refuses the plan change, and writes no new row, when the old plan changed before it could be retired", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_1", "active"));

        // A webhook writes the old row between the facade's read and its retire. The store's own revision guard then
        // refuses the retire, because the facade's revision is stale.
        let webhookWritten = false;
        const racing = Object.assign(Object.create(store) as object, {
            upsertSubscription: async (record: Subscription, guard?: RevisionGuard) => {
                if (record.id === "sub_1" && guard !== undefined && !webhookWritten) {
                    webhookWritten = true;
                    await store.upsertSubscription({ ...subscription("user_1", "active"), priceId: "price_webhook" });
                }

                return store.upsertSubscription(record, guard);
            },
        }) as PaymentStore;

        const adapter = fakeAdapter({
            getSubscriptionStatus: async () => {
                return { ...subscription("user_1", "active"), id: "sub_2", priceId: "price_2" };
            },
            updateSubscription: async (_id, patch) => {
                return { ...subscription("user_1", "active"), id: "sub_2", priceId: patch.priceId ?? "price_2" };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store: racing });

        await expect(payment.updateSubscription("sub_1", { priceId: "price_2" })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
        await expect(store.getSubscription("stripe", "sub_2")).resolves.toBeUndefined();
        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ state: "active" });
    });

    it("does not give the old plan back when the destination was made to grant access during the race", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_1", "active"));

        // A webhook activates the destination between the target lookup and the write, so the provider's answer is refused.
        const racing = Object.assign(Object.create(store) as object, {
            upsertSubscription: async (record: Subscription, guard?: RevisionGuard) => {
                if (record.id === "sub_2") {
                    await store.upsertSubscription({ ...subscription("user_1", "active"), id: "sub_2" });

                    return false;
                }

                return store.upsertSubscription(record, guard);
            },
        }) as PaymentStore;

        const adapter = fakeAdapter({
            getSubscriptionStatus: async () => {
                return { ...subscription("user_1", "active"), id: "sub_2", priceId: "price_2" };
            },
            updateSubscription: async (_id, patch) => {
                return { ...subscription("user_1", "active"), id: "sub_2", priceId: patch.priceId ?? "price_2" };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store: racing });

        await expect(payment.updateSubscription("sub_1", { priceId: "price_2" })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ state: "canceled" });
        await expect(store.getSubscription("stripe", "sub_2")).resolves.toMatchObject({ state: "active" });
    });

    it("gives the old plan back when the new row cannot be stored, instead of leaving the subscription with no access", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_1", "active"));

        // A paused row for the destination appears between the target lookup and the write, so the provider's active
        // answer for it is refused by the revision guard.
        const racing = Object.assign(Object.create(store) as object, {
            upsertSubscription: (record: Subscription, guard?: RevisionGuard) => {
                if (record.id === "sub_2") {
                    return Promise.resolve(false);
                }

                return store.upsertSubscription(record, guard);
            },
        }) as PaymentStore;

        const adapter = fakeAdapter({
            getSubscriptionStatus: async () => {
                return { ...subscription("user_1", "active"), id: "sub_2", priceId: "price_2" };
            },
            updateSubscription: async (_id, patch) => {
                return { ...subscription("user_1", "active"), id: "sub_2", priceId: patch.priceId ?? "price_2" };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store: racing });

        await expect(payment.updateSubscription("sub_1", { priceId: "price_2" })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ state: "active" });
        await expect(store.getSubscription("stripe", "sub_2")).resolves.toBeUndefined();
    });

    it("raises a conflict when a webhook moves the row during the provider call, and keeps the stored plan", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_1", "active"));

        // Every guarded write loses a race, so the provider's answer cannot be recorded over the moved row.
        const racing = Object.assign(Object.create(store) as object, {
            upsertSubscription: (record: Subscription, guard?: RevisionGuard) => {
                if (guard !== undefined) {
                    return Promise.resolve(false);
                }

                return store.upsertSubscription(record, guard);
            },
        }) as PaymentStore;

        const adapter = fakeAdapter({
            updateSubscription: async (id, patch) => {
                return { ...subscription("user_1", "active"), id, priceId: patch.priceId ?? "price_1" };
            },
        });
        const payment = createPayment({ adapter, authorize: (referenceId) => referenceId === "user_1", store: racing });

        await expect(payment.updateSubscription("sub_1", { priceId: "price_2" })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ priceId: "price_1" });
    });
});

describe("createPayment — provider info", () => {
    it("exposes the configured provider's identifier and capabilities", () => {
        expect.assertions(1);

        const payment = createPayment({ adapter: fakeAdapter(), authorize: () => true, store: new MemoryPaymentStore() });

        expect(payment.provider).toStrictEqual({
            capabilities: { checkoutExpiry: true, merchantOfRecord: false, portal: true, usageMetering: true },
            identifier: "stripe",
        });
    });

    it("does not hand out the adapter", () => {
        expect.assertions(4);

        const adapter = fakeAdapter();
        const payment = createPayment({ adapter, authorize: () => true, store: new MemoryPaymentStore() });

        expect("adapter" in payment).toBe(false);
        expect(Object.values(payment)).not.toContain(adapter);
        expect(payment.provider.capabilities).not.toBe(adapter.capabilities);
        expect(Object.values(payment.provider).some((value) => typeof value === "function")).toBe(false);
    });

    it("copies only the declared capability fields, so an operation on the adapter's capabilities is not reachable", () => {
        expect.assertions(2);

        const capabilities = { checkoutExpiry: true, merchantOfRecord: false, portal: true, refundAll: () => "refunded", usageMetering: true };
        const payment = createPayment({
            adapter: fakeAdapter({ capabilities }),
            authorize: () => true,
            store: new MemoryPaymentStore(),
        });

        expect("refundAll" in payment.provider.capabilities).toBe(false);
        expect(new Set(Object.keys(payment.provider.capabilities))).toStrictEqual(new Set(["checkoutExpiry", "merchantOfRecord", "portal", "usageMetering"]));
    });

    it("is frozen, and changing it does not change what the facade does", async () => {
        expect.assertions(4);

        const payment = createPayment({ adapter: fakeAdapter(), authorize: () => true, store: new MemoryPaymentStore() });

        expect(Object.isFrozen(payment.provider)).toBe(true);
        expect(Object.isFrozen(payment.provider.capabilities)).toBe(true);
        expect(() => {
            (payment.provider.capabilities as { checkoutExpiry?: boolean }).checkoutExpiry = false;
        }).toThrow(TypeError);

        // The facade reads the adapter, not the copy, so the expiry it refuses or allows is unchanged.
        await expect(
            payment.createCheckout({
                cancelUrl: "https://x/cancel",
                expiresAt: Date.now() + 60_000,
                mode: "payment",
                priceId: "price_1",
                referenceId: "user_1",
                successUrl: "https://x/ok",
            }),
        ).resolves.toMatchObject({ id: "cs_1" });
    });
});
