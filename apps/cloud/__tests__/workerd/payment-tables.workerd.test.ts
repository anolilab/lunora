/**
 * The `@lunora/payment` tables against the real control-plane D1 in workerd.
 *
 * The payment store reads and writes `payment_customers`, `payment_events`,
 * `payment_sessions`, `payment_subscriptions` and `payment_usageEvents`. The
 * node suite drives the erasure and retention code over a `ctx` double that
 * answers whatever table name it is handed, so it cannot tell whether those
 * names exist in the schema. Here the schema is migrated into a real D1 and the
 * webhook, the entitlement read, the erasure and the retention sweep all go
 * through it.
 */
import type { D1CtxDbOptions } from "@lunora/d1";
import { runD1GlobalTableMigrations } from "@lunora/d1";
import type { PaymentAdapter, WebhookAction } from "@lunora/payment";
import { paymentsFromContext } from "@lunora/payment";
import { bindTableFacade } from "@lunora/server";
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import type { Id } from "../../lunora/_generated/dataModel";
import type { MutationCtx } from "../../lunora/_generated/server";
import { orgEntitlements } from "../../lunora/entitlements";
import { purgeDeleted } from "../../lunora/organizations";
import { ERASED_REFERENCE } from "../../lunora/purge";
import { financialCutoff, prune, WEBHOOK_EVENT_RETENTION_MS } from "../../lunora/retention";
import schema from "../../lunora/schema";
import { buildExec, controlPlaneDatabase } from "../../src/d1-store";

const DAY = 24 * 60 * 60 * 1000;

const database = controlPlaneDatabase(env.DB);

/** A function context over the real store, with a facade per table as the generated `ctx.db` binds. */
const context = (now = Date.now()): MutationCtx => {
    const facades = database as unknown as Record<string, ReturnType<typeof bindTableFacade>>;

    for (const table of Object.keys((schema as unknown as { tables: Record<string, unknown> }).tables)) {
        facades[table] = bindTableFacade(database as never, table);
    }

    return { auth: { userId: null }, db: database, now } as unknown as MutationCtx;
};

const rows = async (table: string, where: Record<string, unknown>): Promise<Record<string, unknown>[]> => {
    const { page } = await database.findMany(table, { where });

    return page as Record<string, unknown>[];
};

const organization = async (fields: Record<string, unknown> = {}): Promise<Id<"organizations">> => {
    const now = Date.now();
    const cellId = (await database.insert("cells", {
        cloudflareAccountId: "acc",
        createdAt: now,
        dispatchNamespacePrefix: "ns",
        name: `cell-${crypto.randomUUID()}`,
        status: "active",
    })) as string;

    return (await database.insert("organizations", {
        cellId,
        createdAt: now,
        name: "Billing",
        plan: "free",
        slug: `billing-${crypto.randomUUID()}`,
        ...fields,
    })) as Id<"organizations">;
};

/** An adapter whose only job is to hand the store the action it is given. */
const webhookAdapter = (action: () => WebhookAction): PaymentAdapter =>
    ({
        capabilities: {},
        identifier: "creem",
        parseWebhook: async () => action(),
    }) as unknown as PaymentAdapter;

const deliver = async (action: WebhookAction): Promise<{ body: Record<string, unknown>; status: number }> => {
    const payments = paymentsFromContext(context() as never, { adapter: webhookAdapter(() => action) });
    const response = await payments.handleWebhook(new Request("https://internal/billing/webhook", { body: "{}", method: "POST" }));

    return { body: await response.json(), status: response.status };
};

describe("payment tables (workerd, real D1)", () => {
    beforeAll(async () => {
        await runD1GlobalTableMigrations(buildExec(env.DB), schema as unknown as D1CtxDbOptions["schema"]);
    });

    it("applies a subscription webhook into the payment tables, and the entitlement read sees it", async () => {
        const organizationId = await organization();
        const subscriptionId = `sub_${crypto.randomUUID()}`;
        const created = `evt_${crypto.randomUUID()}`;

        await expect(
            deliver({
                eventId: created,
                priceId: "price_pro_monthly",
                provider: "creem",
                referenceId: organizationId,
                subscriptionId,
                type: "subscription.active",
            }),
        ).resolves.toStrictEqual({ body: { applied: true, reason: "ok" }, status: 200 });

        // A second event patches the row the first one wrote; a redelivery is deduplicated.
        await expect(
            deliver({ eventId: `evt_${crypto.randomUUID()}`, provider: "creem", quantity: 3, subscriptionId, type: "subscription.updated" }),
        ).resolves.toMatchObject({
            body: { applied: true },
            status: 200,
        });
        await expect(
            deliver({
                eventId: created,
                priceId: "price_pro_monthly",
                provider: "creem",
                referenceId: organizationId,
                subscriptionId,
                type: "subscription.active",
            }),
        ).resolves.toStrictEqual({ body: { applied: false, reason: "duplicate" }, status: 200 });

        await expect(rows("payment_events", { providerEventId: created })).resolves.toMatchObject([{ provider: "creem", type: "subscription.active" }]);
        await expect(rows("payment_subscriptions", { referenceId: organizationId })).resolves.toMatchObject([
            { priceId: "price_pro_monthly", providerSubscriptionId: subscriptionId, quantity: 3, state: "active" },
        ]);

        const entitlements = await orgEntitlements(context(), organizationId);

        expect(entitlements.plans).toContain("pro");
    });

    it("erases an organization's payment rows: deletes the customer and usage, anonymises sessions and subscriptions", async () => {
        const now = Date.now();
        const organizationId = await organization({ deletionRequestedAt: now - 400 * DAY });
        const reference = { provider: "creem", referenceId: organizationId };

        await database.insert("payment_customers", {
            ...reference,
            createdAt: now,
            email: "buyer@example.de",
            providerCustomerId: `pc_${crypto.randomUUID()}`,
        });
        await database.insert("payment_usageEvents", {
            ...reference,
            createdAt: now,
            featureId: "requests",
            idempotencyKey: crypto.randomUUID(),
            quantity: 1,
            reportedToProvider: false,
        });

        const session = (await database.insert("payment_sessions", {
            ...reference,
            amountMinor: 4900,
            capturedMinor: 4900,
            createdAt: now,
            currency: "EUR",
            providerSessionId: `sess_${crypto.randomUUID()}`,
            refundedMinor: 0,
            state: "captured",
            subscriptionId: `sub_${crypto.randomUUID()}`,
            updatedAt: now,
        })) as string;
        const subscription = (await database.insert("payment_subscriptions", {
            ...reference,
            cancelAtPeriodEnd: false,
            createdAt: now,
            priceId: "price_pro_monthly",
            providerSubscriptionId: `sub_${crypto.randomUUID()}`,
            quantity: 1,
            state: "active",
            updatedAt: now,
        })) as string;

        await purgeDeleted.handler(context(now), {});

        await expect(rows("organizations", { _id: organizationId })).resolves.toStrictEqual([]);
        await expect(rows("payment_customers", { referenceId: organizationId })).resolves.toStrictEqual([]);
        await expect(rows("payment_usageEvents", { referenceId: organizationId })).resolves.toStrictEqual([]);
        await expect(rows("payment_sessions", { _id: session })).resolves.toMatchObject([
            {
                amountMinor: 4900,
                currency: "EUR",
                providerSessionId: `erased:${session}`,
                referenceId: ERASED_REFERENCE,
                state: "captured",
                subscriptionId: `erased:${session}`,
            },
        ]);
        await expect(rows("payment_subscriptions", { _id: subscription })).resolves.toMatchObject([
            { priceId: "price_pro_monthly", providerSubscriptionId: `erased:${subscription}`, referenceId: ERASED_REFERENCE, state: "active" },
        ]);
    });

    it("prunes anonymised financial rows past their retention, and old webhook events", async () => {
        const now = Date.now();
        const session = (fields: Record<string, unknown>) =>
            database.insert("payment_sessions", {
                amountMinor: 100,
                capturedMinor: 100,
                createdAt: 0,
                currency: "EUR",
                provider: "creem",
                providerSessionId: `sess_${crypto.randomUUID()}`,
                refundedMinor: 0,
                state: "captured",
                ...fields,
            }) as Promise<string>;
        const expired = await session({ referenceId: ERASED_REFERENCE, updatedAt: financialCutoff(now) - DAY });
        const kept = await session({ referenceId: ERASED_REFERENCE, updatedAt: financialCutoff(now) + DAY });
        const live = await session({ referenceId: "org_live", updatedAt: financialCutoff(now) - DAY });
        const oldEvent = `evt_${crypto.randomUUID()}`;
        const newEvent = `evt_${crypto.randomUUID()}`;

        await database.insert("payment_events", {
            processedAt: now - WEBHOOK_EVENT_RETENTION_MS - DAY,
            provider: "creem",
            providerEventId: oldEvent,
            type: "x",
        });
        await database.insert("payment_events", { processedAt: now - DAY, provider: "creem", providerEventId: newEvent, type: "x" });

        await prune.handler(context(now), {});

        await expect(rows("payment_sessions", { _id: expired })).resolves.toStrictEqual([]);
        await expect(rows("payment_sessions", { _id: kept })).resolves.toHaveLength(1);
        await expect(rows("payment_sessions", { _id: live })).resolves.toHaveLength(1);
        await expect(rows("payment_events", { providerEventId: oldEvent })).resolves.toStrictEqual([]);
        await expect(rows("payment_events", { providerEventId: newEvent })).resolves.toHaveLength(1);
    });
});
