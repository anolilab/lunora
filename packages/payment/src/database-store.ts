/**
 * A {@link PaymentStore} backed by Lunora's own data layer.
 *
 * Rather than ship a bespoke `PaymentDO`, payment state rides the app's existing ShardDO: the
 * `paymentTables` are merged into the app schema and this store reads/writes them through a small
 * `PaymentDb` port that `ctx.db` satisfies. That inherits Lunora's OCC, reactivity, sharding, and
 * `.global()`/D1 read path for free. The codecs below are the single source of truth for the
 * domain ⇄ row mapping (money split into `amountMinor` + `currency`, id ⇄ `provider<Thing>Id`).
 */
import { money } from "./money";
import type { PaymentStore } from "./store";
import { foldUsage } from "./store";
import type { Customer, PaymentSession, PaymentState, ProviderId, Subscription, SubscriptionState, UsageEvent } from "./types";

/**
 * A stored row, carrying Lunora's document id.
 * @experimental
 */
interface PaymentRow extends Record<string, unknown> {
    readonly _id: string;
}

/**
 * Minimal write/read surface this store needs; `ctx.db` satisfies it structurally.
 * @experimental
 */
interface PaymentDatabase {
    delete: (id: string) => Promise<void>;
    findFirst: (table: string, where: Record<string, unknown>) => Promise<PaymentRow | null>;
    findMany: (table: string, where: Record<string, unknown>) => Promise<PaymentRow[]>;
    insert: (table: string, document: Record<string, unknown>) => Promise<string>;
    patch: (id: string, patch: Record<string, unknown>) => Promise<void>;
}

const readString = (row: PaymentRow, key: string): string => (typeof row[key] === "string" ? row[key] : "");

const readOptionalString = (row: PaymentRow, key: string): string | undefined => (typeof row[key] === "string" ? row[key] : undefined);

const readNumber = (row: PaymentRow, key: string): number => (typeof row[key] === "number" ? row[key] : 0);

const readOptionalNumber = (row: PaymentRow, key: string): number | undefined => (typeof row[key] === "number" ? row[key] : undefined);

const readBoolean = (row: PaymentRow, key: string): boolean => row[key] === true;

const readBigint = (row: PaymentRow, key: string): bigint => {
    const value = row[key];

    if (typeof value === "bigint") {
        return value;
    }

    return typeof value === "number" || typeof value === "string" ? BigInt(value) : 0n;
};

const customerToRow = (customer: Customer): Record<string, unknown> => {
    return {
        createdAt: customer.createdAt,
        email: customer.email,
        provider: customer.provider,
        providerCustomerId: customer.id,
        referenceId: customer.referenceId,
    };
};

const rowToCustomer = (row: PaymentRow): Customer => {
    return {
        createdAt: readNumber(row, "createdAt"),
        email: readOptionalString(row, "email"),
        id: readString(row, "providerCustomerId"),
        provider: readString(row, "provider") as ProviderId,
        referenceId: readString(row, "referenceId"),
    };
};

const sessionToRow = (session: PaymentSession): Record<string, unknown> => {
    return {
        amountMinor: session.amount.minorUnits,
        capturedMinor: session.capturedAmount.minorUnits,
        createdAt: session.createdAt,
        currency: session.amount.currency,
        provider: session.provider,
        providerSessionId: session.id,
        referenceId: session.referenceId,
        refundedMinor: session.refundedAmount.minorUnits,
        state: session.state,
        updatedAt: session.updatedAt,
    };
};

const rowToSession = (row: PaymentRow): PaymentSession => {
    const currency = readString(row, "currency");

    return {
        amount: money(readBigint(row, "amountMinor"), currency),
        capturedAmount: money(readBigint(row, "capturedMinor"), currency),
        createdAt: readNumber(row, "createdAt"),
        id: readString(row, "providerSessionId"),
        provider: readString(row, "provider") as ProviderId,
        referenceId: readString(row, "referenceId"),
        refundedAmount: money(readBigint(row, "refundedMinor"), currency),
        state: readString(row, "state") as PaymentState,
        updatedAt: readNumber(row, "updatedAt"),
    };
};

const subscriptionToRow = (subscription: Subscription): Record<string, unknown> => {
    return {
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        createdAt: subscription.createdAt,
        currentPeriodEnd: subscription.currentPeriodEnd,
        currentPeriodStart: subscription.currentPeriodStart,
        priceId: subscription.priceId,
        provider: subscription.provider,
        providerSubscriptionId: subscription.id,
        quantity: subscription.quantity,
        referenceId: subscription.referenceId,
        state: subscription.state,
        updatedAt: subscription.updatedAt,
    };
};

const rowToSubscription = (row: PaymentRow): Subscription => {
    return {
        cancelAtPeriodEnd: readBoolean(row, "cancelAtPeriodEnd"),
        createdAt: readNumber(row, "createdAt"),
        currentPeriodEnd: readOptionalNumber(row, "currentPeriodEnd"),
        currentPeriodStart: readOptionalNumber(row, "currentPeriodStart"),
        id: readString(row, "providerSubscriptionId"),
        priceId: readString(row, "priceId"),
        provider: readString(row, "provider") as ProviderId,
        quantity: readNumber(row, "quantity"),
        referenceId: readString(row, "referenceId"),
        state: readString(row, "state") as SubscriptionState,
        updatedAt: readNumber(row, "updatedAt"),
    };
};

const usageEventToRow = (event: UsageEvent): Record<string, unknown> => {
    return {
        createdAt: event.createdAt,
        featureId: event.featureId,
        idempotencyKey: event.idempotencyKey,
        // Omitted for a plain "add" so existing rows and new ones look the same
        // (the fold treats an absent mode as "add").
        ...(event.mode === "set" ? { mode: "set" } : {}),
        provider: event.provider,
        quantity: event.quantity,
        referenceId: event.referenceId,
        reportedToProvider: event.reportedToProvider,
    };
};

/**
 * `createDatabasePaymentStore` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export const createDatabasePaymentStore = (database: PaymentDatabase): PaymentStore => {
    const upsert = async (table: string, where: Record<string, unknown>, row: Record<string, unknown>): Promise<void> => {
        const existing = await database.findFirst(table, where);

        if (existing) {
            await database.patch(existing._id, row);

            return;
        }

        await database.insert(table, row);
    };

    return {
        getCustomerByReference: async (provider, referenceId) => {
            const row = await database.findFirst("customers", { provider, referenceId });

            return row ? rowToCustomer(row) : undefined;
        },

        getPaymentSession: async (provider, id) => {
            const row = await database.findFirst("paymentSessions", { provider, providerSessionId: id });

            return row ? rowToSession(row) : undefined;
        },

        getSubscription: async (provider, id) => {
            const row = await database.findFirst("subscriptions", { provider, providerSubscriptionId: id });

            return row ? rowToSubscription(row) : undefined;
        },

        listSubscriptionsByReference: async (referenceId) => {
            const rows = await database.findMany("subscriptions", { referenceId });

            return rows.map((row) => rowToSubscription(row));
        },

        markEventProcessed: async (provider, eventId) => {
            const existing = await database.findFirst("events", { provider, providerEventId: eventId });

            if (existing) {
                return false;
            }

            // The unique `by_provider_event` index is the real race guard in the DO; a concurrent
            // insert of the same event id fails its OCC commit, so at most one caller wins.
            await database.insert("events", { processedAt: Date.now(), provider, providerEventId: eventId, type: "" });

            return true;
        },

        releaseEvent: async (provider, eventId) => {
            // Roll back a claim whose apply threw, so the provider's retry re-processes it. The
            // delete races nothing the insert-claim doesn't already serialize: only the caller that
            // won the claim reaches the failing apply, and only it releases its own row.
            const existing = await database.findFirst("events", { provider, providerEventId: eventId });

            if (existing) {
                await database.delete(existing._id);
            }
        },

        markUsageReported: async (provider, idempotencyKey) => {
            const existing = await database.findFirst("usageEvents", { idempotencyKey, provider });

            if (existing) {
                await database.patch(existing._id, { reportedToProvider: true });
            }
        },

        recordUsage: async (event) => {
            const existing = await database.findFirst("usageEvents", { idempotencyKey: event.idempotencyKey, provider: event.provider });

            if (existing) {
                return false;
            }

            // The unique `by_idempotency` index is the real race guard in the DO: a concurrent
            // insert of the same key fails its OCC commit, so at most one caller wins.
            await database.insert("usageEvents", usageEventToRow(event));

            return true;
        },

        sumUsage: async (referenceId, featureId, since) => {
            // NOTE: this reads the full lifetime ledger for the pair and filters in memory — O(events)
            // per call. Fine for typical volumes; for hot metered features, add a per-period rollup row
            // (or a createdAt-range query) so old periods aren't re-scanned on every check/track.
            const rows = await database.findMany("usageEvents", { featureId, referenceId });
            const window = rows
                .filter((row) => readNumber(row, "createdAt") >= since)
                .map((row) => {
                    return {
                        createdAt: readNumber(row, "createdAt"),
                        idempotencyKey: typeof row["idempotencyKey"] === "string" ? row["idempotencyKey"] : "",
                        mode: row["mode"] === "set" ? ("set" as const) : ("add" as const),
                        quantity: readNumber(row, "quantity"),
                    };
                });

            // Shared with `MemoryPaymentStore` so a "set" marker resets the period
            // total identically in both — see `foldUsage`.
            return foldUsage(window);
        },

        upsertCustomer: async (customer) => upsert("customers", { provider: customer.provider, providerCustomerId: customer.id }, customerToRow(customer)),

        upsertPaymentSession: async (session) =>
            upsert("paymentSessions", { provider: session.provider, providerSessionId: session.id }, sessionToRow(session)),

        upsertSubscription: async (subscription) =>
            upsert("subscriptions", { provider: subscription.provider, providerSubscriptionId: subscription.id }, subscriptionToRow(subscription)),
    };
};

export type { PaymentDatabase, PaymentRow };
