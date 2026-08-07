import { describe, expect, it } from "vitest";

import type { PaymentAdapter } from "../src/adapter";
import { createPayment } from "../src/create-payment";
import { money } from "../src/money";
import { MemoryPaymentStore } from "../src/store";
import type { Subscription, WebhookAction } from "../src/types";

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

    it("track mode:set reconciles the period total via a delta", async () => {
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
});
