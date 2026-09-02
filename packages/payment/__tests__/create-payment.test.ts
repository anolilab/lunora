import { describe, expect, it, vi } from "vitest";

import type { PaymentAdapter } from "../src/adapter";
import type { WebhookOutcome } from "../src/create-payment";
import { createPayment, webhookResponse } from "../src/create-payment";
import { money } from "../src/money";
import { MemoryPaymentStore } from "../src/store";
import applyWebhookAction from "../src/sync";
import type { PaymentSession, Subscription, WebhookAction } from "../src/types";

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
        capabilities: { merchantOfRecord: false, portal: true, usageMetering: true },
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

        const payment = createPayment({ adapter: fakeAdapter(), store: new MemoryPaymentStore() });

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
            const payment = createPayment({ adapter, store: new MemoryPaymentStore() });

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
        expect.assertions(8);

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
            const payment = createPayment({ adapter, store: new MemoryPaymentStore() });

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

        // An identical repeat still dedupes onto the same key.
        await expect(keyFor()).resolves.toBe(baseline);
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

        await payment.createCheckout({
            cancelUrl: "https://x/cancel",
            // Attacker-chosen victim customer — must be dropped in favor of the store-derived one.
            customerId: "cus_victim",
            mode: "payment",
            priceId: "price_1",
            referenceId: "user_1",
            successUrl: "https://x/ok",
        });

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
        });

        expect(forwarded).toBe("cus_1");
        expect(forwarded).not.toBe("cus_victim");
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

                return paymentSession("user_1");
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

        const adapter = fakeAdapter({ refundPayment: async () => paymentSession("user_1") });
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

        const adapter = fakeAdapter({ identifier: "polar", refundPayment: async () => polarSession });
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

        let issued = 0;
        const adapter = fakeAdapter({
            identifier: "polar",
            refundPayment: async () => {
                issued += 1;

                return { ...polarSession, refundId: `ref_${String(issued)}` };
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

                return { ...polarSession, refundId: `ref_${String(forwarded.length)}` };
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

        const payment = createPayment({ adapter: fakeAdapter(), store: new MemoryPaymentStore() });

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

        expect(forwardedKey).toBe("cancel_payment:stripe:pi_1");

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
        const payment = createPayment({ adapter: fakeAdapter({ parseWebhook: async () => action }), store });

        const response = await payment.handleWebhook(new Request("https://app.test/payment/webhook", { body: "{}", method: "POST" }));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ applied: true, reason: "ok" });

        const session = await store.getPaymentSession("stripe", "pi_1");

        expect(session?.state).toBe("captured");
        expect(session?.capturedAmount.minorUnits).toBe(1000n);
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
        const payment = createPayment({ adapter: fakeAdapter({ parseWebhook: async () => action }), store: new MemoryPaymentStore() });

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
            const payment = createPayment({ adapter: fakeAdapter({ parseWebhook: async () => action }), store: new MemoryPaymentStore() });
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
        const payment = createPayment({ adapter: fakeAdapter({ parseWebhook: async () => action }), store: new MemoryPaymentStore() });

        const response = await payment.handleWebhook(new Request("https://app.test/payment/webhook", { body: "{}", method: "POST" }));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ applied: false, reason: "unhandled" });
    });

    it("returns the error status when webhook verification fails", async () => {
        expect.assertions(2);

        const adapter = fakeAdapter({
            parseWebhook: async () => {
                const { LunoraPaymentError } = await import("../src/errors");

                throw new LunoraPaymentError("WEBHOOK_SIGNATURE_INVALID", "bad signature");
            },
        });
        const payment = createPayment({ adapter, store: new MemoryPaymentStore() });

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
                const { LunoraPaymentError } = await import("../src/errors");

                throw new LunoraPaymentError("PROVIDER_ERROR", "upstream provider timed out");
            },
        });
        const payment = createPayment({ adapter, store: new MemoryPaymentStore() });

        const response = await payment.handleWebhook(new Request("https://app.test/payment/webhook", { body: "{}", method: "POST" }));

        // `PROVIDER_ERROR` maps to 502 in `LunoraPaymentError`'s own status map —
        // distinct from `WEBHOOK_SIGNATURE_INVALID`'s 400 above — confirming
        // `toErrorBody`'s status for this branch tracks `error.status`, not a
        // hardcoded literal.
        expect(response.status).toBe(502);
        await expect(response.json()).resolves.toEqual({ error: "upstream provider timed out" });
    });

    it("masks an unrecognized webhook-parsing throw behind a generic 400 (unchanged, non-LunoraPaymentError branch)", async () => {
        expect.assertions(2);

        const adapter = fakeAdapter({
            parseWebhook: async () => {
                throw new Error("driver error: connection reset");
            },
        });
        const payment = createPayment({ adapter, store: new MemoryPaymentStore() });

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

        const payment = createPayment({ adapter: fakeAdapter(), store: new MemoryPaymentStore() });

        const result = await payment.attach({ cancelUrl: "https://x/cancel", priceId: "price_1", referenceId: "user_1", successUrl: "https://x/ok" });

        expect(result.url).toMatch(/^https:\/\/pay\.test\/checkout:stripe:[0-9a-f]{64}$/);
    });

    it("attach honors an explicit one-time payment mode", async () => {
        expect.assertions(1);

        const payment = createPayment({ adapter: fakeAdapter(), store: new MemoryPaymentStore() });

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

        const payment = createPayment({ adapter: fakeAdapter(), store: new MemoryPaymentStore() });

        await expect(payment.check({ featureId: "export", referenceId: "user_1" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    });

    it("check grants an unlimited boolean feature from an active plan", async () => {
        expect.assertions(1);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(activeSubscription("user_1"));

        const payment = createPayment({ adapter: fakeAdapter(), entitlements, store });

        await expect(payment.check({ featureId: "export", referenceId: "user_1" })).resolves.toEqual({ allowed: true, unlimited: true });
    });

    it("check denies a feature no active plan grants", async () => {
        expect.assertions(1);

        const payment = createPayment({ adapter: fakeAdapter(), entitlements, store: new MemoryPaymentStore() });

        await expect(payment.check({ featureId: "export", referenceId: "user_1" })).resolves.toEqual({ allowed: false, unlimited: false });
    });

    it("check subtracts tracked usage from a metered limit", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(activeSubscription("user_1"));

        const payment = createPayment({ adapter: fakeAdapter(), entitlements, store });

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

        const payment = createPayment({ adapter: fakeAdapter(), entitlements, store });

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
        const payment = createPayment({ adapter: fakeAdapter({ reportUsage: async () => undefined }), store });

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
        const payment = createPayment({ adapter: fakeAdapter({ reportUsage: undefined }), store });

        await expect(payment.track({ featureId: "api_calls", idempotencyKey: "u1", quantity: 5, referenceId: "user_1" })).resolves.toEqual({
            recorded: true,
            reportedToProvider: false,
        });
    });

    it("track mode:set reconciles the period total", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(activeSubscription("user_1"));

        const payment = createPayment({ adapter: fakeAdapter({ reportUsage: undefined }), entitlements, store });

        await payment.track({ featureId: "api_calls", quantity: 30, referenceId: "user_1" });
        await payment.track({ featureId: "api_calls", mode: "set", quantity: 50, referenceId: "user_1" });

        await expect(payment.check({ featureId: "api_calls", referenceId: "user_1" })).resolves.toMatchObject({ balance: 50, used: 50 });

        // A downward "set" stays local (provider meters are additive) but still corrects the ledger.
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

        const payment = createPayment({ adapter: fakeAdapter({ reportUsage: undefined }), entitlements, store });

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

        const payment = createPayment({ adapter: fakeAdapter({ reportUsage: undefined }), entitlements, store });

        await payment.track({ featureId: "api_calls", quantity: 30, referenceId: "user_1" });
        await payment.track({ featureId: "api_calls", mode: "set", quantity: 5, referenceId: "user_1" });

        // The "set" marker resets the fold: the earlier 30 is discarded, not summed.
        await expect(payment.check({ featureId: "api_calls", referenceId: "user_1" })).resolves.toMatchObject({ used: 5 });

        await payment.track({ featureId: "api_calls", quantity: 7, referenceId: "user_1" });

        // …and an "add" after it accrues on top of the reset total.
        await expect(payment.check({ featureId: "api_calls", referenceId: "user_1" })).resolves.toMatchObject({ used: 12 });
    });

    it("track on a provider without usage metering (Creem-style) records locally only", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();
        const reported: number[] = [];
        const payment = createPayment({
            adapter: fakeAdapter({
                capabilities: { merchantOfRecord: true, portal: true, usageMetering: false },
                reportUsage: async (input) => {
                    reported.push(input.quantity);
                },
            }),
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

        const payment = createPayment({ adapter: fakeAdapter(), store });

        await expect(payment.check({ priceId: "price_1", referenceId: "user_1" })).resolves.toEqual({ allowed: true, unlimited: false });
        await expect(payment.check({ priceId: "price_absent", referenceId: "user_1" })).resolves.toEqual({ allowed: false, unlimited: false });
    });

    it("check throws when given neither a featureId nor a priceId", async () => {
        expect.assertions(1);

        const payment = createPayment({ adapter: fakeAdapter(), entitlements, store: new MemoryPaymentStore() });

        await expect(payment.check({ referenceId: "user_1" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    });

    it("listBalances resolves every configured feature in one call", async () => {
        expect.assertions(1);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(activeSubscription("user_1"));

        const payment = createPayment({ adapter: fakeAdapter(), entitlements, store });

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
        const payment = createPayment({ adapter: fakeAdapter(), entitlements: manyMetered, store });

        const balances = await payment.listBalances("user_1");

        expect(balances.map((balance) => balance.featureId)).toEqual(["api_calls", "exports", "seats"]);
        // N metered features cost one batched read, not N per-feature scans.
        expect(sumUsage).not.toHaveBeenCalled();
        expect(sumUsageByFeature).toHaveBeenCalledTimes(1);
    });
});
