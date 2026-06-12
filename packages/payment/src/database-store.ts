/**
 * A {@link PaymentStore} backed by Cirrus's own data layer.
 *
 * Rather than ship a bespoke `PaymentDO`, payment state rides the app's existing ShardDO: the
 * `paymentTables` are merged into the app schema and this store reads/writes them through a small
 * `PaymentDb` port that `ctx.db` satisfies. That inherits Cirrus's OCC, reactivity, sharding, and
 * `.global()`/D1 read path for free. The codecs below are the single source of truth for the
 * domain ⇄ row mapping (money split into `amountMinor` + `currency`, id ⇄ `provider&lt;Thing>Id`).
 */
import { money } from "./money";
import type { PaymentStore } from "./store";
import type { Customer, PaymentSession, PaymentState, ProviderId, Subscription, SubscriptionState } from "./types";

/** A stored row, carrying Cirrus's document id. */
interface PaymentRow extends Record<string, unknown> {
    readonly _id: string;
}

/** Minimal write/read surface this store needs; `ctx.db` satisfies it structurally. */
interface PaymentDatabase {
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
        id: readString(row, "providerSubscriptionId"),
        priceId: readString(row, "priceId"),
        provider: readString(row, "provider") as ProviderId,
        quantity: readNumber(row, "quantity"),
        referenceId: readString(row, "referenceId"),
        state: readString(row, "state") as SubscriptionState,
        updatedAt: readNumber(row, "updatedAt"),
    };
};

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

        upsertCustomer: async (customer) => upsert("customers", { provider: customer.provider, providerCustomerId: customer.id }, customerToRow(customer)),

        upsertPaymentSession: async (session) =>
            upsert("paymentSessions", { provider: session.provider, providerSessionId: session.id }, sessionToRow(session)),

        upsertSubscription: async (subscription) =>
            upsert("subscriptions", { provider: subscription.provider, providerSubscriptionId: subscription.id }, subscriptionToRow(subscription)),
    };
};

export type { PaymentDatabase, PaymentRow };
