/**
 * The saas template's own billing functions (`templates/saas/lunora/payment`),
 * EXECUTED over an in-memory `ctx.db`: the seat allowance, the plan the webhook
 * records, the checkout hold, and the admin subscription reads. The registry
 * `saas` item's functions are in `registry-saas-items.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

import { env } from "../fixtures/registry-runtime/cloudflare-workers";
import { FUNCTION_PATH } from "../fixtures/registry-runtime/generated-internal";
import type { Handler, Row } from "../helpers/registry-runtime";
import { createDatabase, load, signedIn } from "../helpers/registry-runtime";

describe("saas template seat allowance", () => {
    type SeatAllowance = Handler<{ referenceId: string }, number | null>;

    /** `payment:seatAllowance` over the given subscriptions; the catalog is the template's own `PLANS`. */
    const allowance = async (subscriptions: Row[]): Promise<number | null> => {
        const { seatAllowance } = await load<{ seatAllowance: SeatAllowance }>("templates", "saas", "lunora", "payment", "index.ts");

        return seatAllowance({ args: { referenceId: "org-1" }, ctx: { payments: { listSubscriptions: async () => subscriptions } } });
    };

    it("gives an organisation with no active subscription the free plan's seats", async () => {
        expect.hasAssertions();

        await expect(allowance([])).resolves.toBe(3);
        await expect(allowance([{ priceId: "price_pro", state: "canceled" }])).resolves.toBe(3);
    });

    it("gives an active Pro subscription its ten seats", async () => {
        expect.hasAssertions();

        await expect(allowance([{ priceId: "price_pro", state: "active" }])).resolves.toBe(10);
    });

    it("leaves an organisation on an unmetered plan uncapped, whatever else it holds", async () => {
        expect.hasAssertions();

        await expect(allowance([{ priceId: "price_scale", state: "active" }])).resolves.toBeNull();
        await expect(
            allowance([
                { priceId: "price_pro", state: "active" },
                { priceId: "price_scale", state: "trialing" },
            ]),
        ).resolves.toBeNull();
    });
});

describe("saas template plan sync", () => {
    type ProcessWebhook = Handler<{ body: string; headers: Record<string, string> }, { applied: boolean; status: number }>;

    /** `payment:processWebhook` answering `reply`, with the organisation holding `subscriptions` afterwards. */
    const process = async (reply: Row, subscriptions: Row[]) => {
        const { processWebhook } = await load<{ processWebhook: ProcessWebhook }>("templates", "saas", "lunora", "payment", "index.ts");
        const runMutation = vi.fn<(reference: unknown, args: Row) => Promise<void>>(async () => {});
        const payments = { handleWebhook: async () => Response.json(reply), listSubscriptions: async () => subscriptions };

        await processWebhook({ args: { body: "{}", headers: {} }, ctx: { payments, runMutation } });

        return runMutation.mock.calls.map(([, args]) => args);
    };

    it("records the most expensive active plan after a subscription event", async () => {
        expect.hasAssertions();

        await expect(
            process({ applied: true, referenceId: "org-1" }, [
                { priceId: "price_pro", state: "active", updatedAt: 5 },
                { priceId: "price_scale", state: "active", updatedAt: 9 },
            ]),
        ).resolves.toStrictEqual([{ asOf: 9, organizationId: "org-1", plan: "scale" }]);
    });

    it("puts an organisation whose subscription ended back on the free plan", async () => {
        expect.hasAssertions();

        await expect(process({ applied: true, referenceId: "org-1" }, [{ priceId: "price_pro", state: "canceled", updatedAt: 7 }])).resolves.toStrictEqual([
            { asOf: 7, organizationId: "org-1", plan: "free" },
        ]);
    });

    it("syncs again on a redelivered event, so a sync that failed the first time is finished", async () => {
        expect.hasAssertions();

        await expect(
            process({ applied: false, reason: "duplicate", referenceId: "org-1" }, [{ priceId: "price_pro", state: "active", updatedAt: 3 }]),
        ).resolves.toStrictEqual([{ asOf: 3, organizationId: "org-1", plan: "pro" }]);
    });

    it("touches no plan for an event that names no organisation", async () => {
        expect.hasAssertions();

        await expect(process({ applied: true }, [])).resolves.toStrictEqual([]);
    });
});

describe("saas template checkout", () => {
    type Checkout = Handler<{ priceId: string }, { url: string }>;

    interface Payment {
        checkout: Checkout;
        holdCheckout: Handler<{ priceId: string; referenceId: string }, { holdId: string; sessionExpiresAt: number } | { url: string }>;
        settleCheckoutHold: Handler<{ holdId: string; url: string }, void>;
    }

    const NOW = 1_700_000_000_000;
    const SESSION_MS = 35 * 60_000;
    const HOLD_MS = SESSION_MS + 60_000;

    const setup = async (subscriptions: Row[], { checkoutExpiry = true } = {}) => {
        env["APP_BASE_URL"] = "https://app.example.test";

        const payment = await load<Payment>("templates", "saas", "lunora", "payment", "index.ts");
        const database = createDatabase({ checkout_holds: [["referenceId"]] });
        let sessions = 0;
        const createCheckout = vi.fn<(input: { email?: string; expiresAt?: number; idempotencyKey?: string }) => Promise<{ url: string }>>(async () => {
            sessions += 1;

            return { url: `https://pay.example.test/session-${String(sessions)}` };
        });
        const clock = { now: NOW };
        const auth = signedIn({ activeOrganizationId: "org-1", email: "owner@example.test", orgRole: "owner" });
        // The internal mutations run in the same shard, over the same database.
        const runMutation = async (reference: Record<typeof FUNCTION_PATH, string>, args: Row) => {
            const name = reference[FUNCTION_PATH].replace("payment.", "") as "holdCheckout" | "settleCheckoutHold";

            return (payment[name] as Handler<Row, unknown>)({ args, ctx: { db: database.db, now: clock.now } });
        };
        const ctx = {
            auth,
            payments: {
                adapter: { capabilities: { checkoutExpiry }, identifier: checkoutExpiry ? "stripe" : "polar" },
                createCheckout,
                listSubscriptions: vi.fn<() => Promise<Row[]>>(async () => subscriptions),
            },
            runMutation,
            shardKey: "__root__",
        };
        return { clock, createCheckout, ctx, database, payment };
    };

    it.each(["active", "trialing", "past_due", "paused"])("refuses a second subscription while one is %s", async (state) => {
        expect.assertions(2);

        const { createCheckout, ctx, payment } = await setup([{ state }]);

        await expect(payment.checkout({ args: { priceId: "price_scale" }, ctx })).rejects.toMatchObject({ code: "CONFLICT" });
        expect(createCheckout).not.toHaveBeenCalled();
    });

    it("starts a checkout for an organisation with no live subscription", async () => {
        expect.assertions(2);

        const { createCheckout, ctx, payment } = await setup([{ state: "canceled" }]);

        await expect(payment.checkout({ args: { priceId: "price_scale" }, ctx })).resolves.toStrictEqual({ url: "https://pay.example.test/session-1" });
        expect(createCheckout).toHaveBeenCalledTimes(1);
    });

    it("refuses to run off the root shard, where the billing tables are empty copies", async () => {
        expect.assertions(2);

        const { createCheckout, ctx, payment } = await setup([]);

        await expect(payment.checkout({ args: { priceId: "price_pro" }, ctx: { ...ctx, shardKey: "org-1" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(createCheckout).not.toHaveBeenCalled();
    });

    it("refuses a provider that cannot expire the session, before taking a hold", async () => {
        expect.assertions(3);

        const { createCheckout, ctx, database, payment } = await setup([], { checkoutExpiry: false });

        await expect(payment.checkout({ args: { priceId: "price_pro" }, ctx })).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
        expect(createCheckout).not.toHaveBeenCalled();
        expect(database.rows("checkout_holds")).toHaveLength(0);
    });

    it("hands the provider the caller's verified email for a first customer", async () => {
        expect.assertions(1);

        const { createCheckout, ctx, payment } = await setup([]);

        await payment.checkout({ args: { priceId: "price_pro" }, ctx });

        expect(createCheckout.mock.calls[0]![0].email).toBe("owner@example.test");
    });

    it("has the provider expire the session before the hold ends", async () => {
        expect.assertions(1);

        const { createCheckout, ctx, database, payment } = await setup([]);

        await payment.checkout({ args: { priceId: "price_pro" }, ctx });

        const sessionExpiresAt = createCheckout.mock.calls[0]![0].expiresAt;

        expect([sessionExpiresAt, database.rows("checkout_holds")[0]!["expiresAt"]]).toStrictEqual([NOW + SESSION_MS, NOW + HOLD_MS]);
    });

    it("refuses a checkout for another plan while one is in flight, before either webhook lands", async () => {
        expect.assertions(2);

        const { createCheckout, ctx, payment } = await setup([]);

        await payment.checkout({ args: { priceId: "price_pro" }, ctx });

        await expect(payment.checkout({ args: { priceId: "price_scale" }, ctx })).rejects.toMatchObject({ code: "CONFLICT" });
        expect(createCheckout).toHaveBeenCalledTimes(1);
    });

    it("hands a repeat for the same plan the session already started", async () => {
        expect.assertions(2);

        const { createCheckout, ctx, payment } = await setup([]);

        const first = await payment.checkout({ args: { priceId: "price_pro" }, ctx });

        await expect(payment.checkout({ args: { priceId: "price_pro" }, ctx })).resolves.toStrictEqual(first);
        expect(createCheckout).toHaveBeenCalledTimes(1);
    });

    it("keeps the hold until it expires, and lets another plan start then", async () => {
        expect.assertions(2);

        const { clock, ctx, payment } = await setup([]);

        await payment.checkout({ args: { priceId: "price_pro" }, ctx });

        clock.now += HOLD_MS - 1;

        await expect(payment.checkout({ args: { priceId: "price_scale" }, ctx })).rejects.toMatchObject({ code: "CONFLICT" });

        clock.now += 2;

        await expect(payment.checkout({ args: { priceId: "price_scale" }, ctx })).resolves.toMatchObject({ url: "https://pay.example.test/session-2" });
    });

    it("starts a new session for the same plan once the hold has expired", async () => {
        expect.assertions(1);

        const { clock, ctx, payment } = await setup([]);

        await payment.checkout({ args: { priceId: "price_pro" }, ctx });

        clock.now += HOLD_MS + 1;

        await expect(payment.checkout({ args: { priceId: "price_pro" }, ctx })).resolves.toStrictEqual({ url: "https://pay.example.test/session-2" });
    });

    it("leaves a newer hold alone when a stale provider call settles", async () => {
        expect.assertions(2);

        const { clock, ctx, database, payment } = await setup([]);
        const stale = await payment.holdCheckout({ args: { priceId: "price_pro", referenceId: "org-1" }, ctx: { db: database.db, now: clock.now } });

        clock.now += HOLD_MS + 1;

        await payment.checkout({ args: { priceId: "price_scale" }, ctx });
        await payment.settleCheckoutHold({
            args: { holdId: (stale as { holdId: string }).holdId, url: "https://pay.example.test/stale" },
            ctx: { db: database.db, now: clock.now },
        });

        expect(database.rows("checkout_holds")).toHaveLength(1);
        expect(database.rows("checkout_holds")[0]).toMatchObject({ priceId: "price_scale", url: "https://pay.example.test/session-1" });
    });

    it("keeps the hold when the provider call fails, and retries the same plan under the same key", async () => {
        expect.assertions(5);

        const { createCheckout, ctx, database, payment } = await setup([]);

        createCheckout.mockRejectedValueOnce(new Error("provider timed out"));

        await expect(payment.checkout({ args: { priceId: "price_pro" }, ctx })).rejects.toThrow("provider timed out");
        expect(database.rows("checkout_holds")).toHaveLength(1);
        // The session may exist after all, so another plan must still wait for the hold.
        await expect(payment.checkout({ args: { priceId: "price_scale" }, ctx })).rejects.toMatchObject({ code: "CONFLICT" });

        await payment.checkout({ args: { priceId: "price_pro" }, ctx });

        const keys = createCheckout.mock.calls.map(([input]) => (input as { idempotencyKey?: string }).idempotencyKey);

        expect(keys).toHaveLength(2);
        expect(keys[1]).toBe(keys[0]);
    });
});

describe("saas template admin subscriptions", () => {
    interface Page {
        continueCursor: string | null;
        isDone: boolean;
        page: Row[];
    }

    type AdminSubscriptions = Handler<{ paginationOpts: { cursor?: string | null; endCursor?: string | null; numItems: number } }, Page>;
    type AdminPastDueSubscriptions = Handler<Record<string, never>, { more: boolean; rows: Row[] }>;

    const setup = async (claims: Row, count = 1) => {
        env["APP_BASE_URL"] = "https://app.example.test";

        const { adminPastDueSubscriptions, adminSubscriptions } = await load<{
            adminPastDueSubscriptions: AdminPastDueSubscriptions;
            adminSubscriptions: AdminSubscriptions;
        }>("templates", "saas", "lunora", "payment", "index.ts");
        const database = createDatabase({});

        for (let index = 1; index <= count; index += 1) {
            database.rows("payment_subscriptions").push({
                _id: `s${String(index)}`,
                priceId: "price_pro",
                providerSubscriptionId: `sub_${String(index)}`,
                referenceId: `org-${String(index)}`,
                state: "active",
            });
        }

        // Every tenant but the last is in the projection; the last was deleted.
        for (let index = 1; index <= count; index += 1) {
            database.rows("saas_organizations").push({
                _id: `o${String(index)}`,
                name: `Org ${String(index)}`,
                organizationId: `org-${String(index)}`,
                status: index === count ? "deleted" : "active",
            });
        }

        return { adminPastDueSubscriptions, adminSubscriptions, ctx: { auth: signedIn(claims), database, db: database.db, shardKey: "__root__" } };
    };

    it("refuses a platform admin on a tenant shard instead of reading its empty copy", async () => {
        expect.assertions(1);

        const { adminSubscriptions, ctx } = await setup({ appRole: "admin" });

        await expect(adminSubscriptions({ args: { paginationOpts: { numItems: 10 } }, ctx: { ...ctx, shardKey: "org-1" } })).rejects.toMatchObject({
            code: "FORBIDDEN",
            message: expect.stringContaining("root shard"),
        });
    });

    it("refuses anyone without the platform admin role", async () => {
        expect.assertions(1);

        const { adminSubscriptions, ctx } = await setup({ appRole: "user" });

        await expect(adminSubscriptions({ args: { paginationOpts: { numItems: 10 } }, ctx })).rejects.toMatchObject({
            code: "FORBIDDEN",
            message: expect.stringContaining("platform admin"),
        });
    });

    it("pages the root shard's subscriptions newest first, carrying the organisation each bills", async () => {
        expect.assertions(4);

        const { adminSubscriptions, ctx } = await setup({ appRole: "user,admin" }, 3);
        const first = await adminSubscriptions({ args: { paginationOpts: { cursor: null, numItems: 2 } }, ctx });

        // org-3 is deleted, so its row carries no organisation and the table shows its id.
        expect(first.page.map((row) => [row["providerSubscriptionId"], (row["organization"] as Row | undefined)?.["name"]])).toStrictEqual([
            ["sub_3", undefined],
            ["sub_2", "Org 2"],
        ]);
        expect(first.isDone).toBe(false);

        const second = await adminSubscriptions({ args: { paginationOpts: { cursor: first.continueCursor, numItems: 2 } }, ctx });

        expect(second.page.map((row) => row["providerSubscriptionId"])).toStrictEqual(["sub_1"]);
        expect(second.isDone).toBe(true);
    });

    it("finds an older past-due subscription the newest page does not reach", async () => {
        expect.assertions(2);

        const { adminPastDueSubscriptions, adminSubscriptions, ctx } = await setup({ appRole: "admin" }, 4);

        // s1 is the oldest row; put it in dunning.
        ctx.database.rows("payment_subscriptions")[0]!["state"] = "past_due";

        const firstPage = await adminSubscriptions({ args: { paginationOpts: { numItems: 2 } }, ctx });

        expect(firstPage.page.map((row) => row["state"])).toStrictEqual(["active", "active"]);
        await expect(adminPastDueSubscriptions({ args: {}, ctx })).resolves.toMatchObject({
            more: false,
            rows: [{ providerSubscriptionId: "sub_1", state: "past_due" }],
        });
    });

    it("bounds the dunning read, and says when there are more", async () => {
        expect.assertions(2);

        const { adminPastDueSubscriptions, ctx } = await setup({ appRole: "admin" }, 101);

        for (const row of ctx.database.rows("payment_subscriptions")) {
            row["state"] = "past_due";
        }

        const { more, rows } = await adminPastDueSubscriptions({ args: {}, ctx });

        expect(rows).toHaveLength(100);
        expect(more).toBe(true);
    });

    it("refuses the dunning read off the root shard and to anyone but a platform admin", async () => {
        expect.assertions(2);

        const admin = await setup({ appRole: "admin" });
        const member = await setup({ appRole: "user" });

        await expect(admin.adminPastDueSubscriptions({ args: {}, ctx: { ...admin.ctx, shardKey: "org-1" } })).rejects.toMatchObject({
            code: "FORBIDDEN",
            message: expect.stringContaining("root shard"),
        });
        await expect(member.adminPastDueSubscriptions({ args: {}, ctx: member.ctx })).rejects.toMatchObject({
            code: "FORBIDDEN",
            message: expect.stringContaining("platform admin"),
        });
    });

    it("caps a page however many rows the caller asks for", async () => {
        expect.assertions(2);

        const { adminSubscriptions, ctx } = await setup({ appRole: "admin" }, 150);
        const page = await adminSubscriptions({ args: { paginationOpts: { numItems: 10_000 } }, ctx });

        expect(page.page).toHaveLength(100);
        expect(page.isDone).toBe(false);
    });
});
