/**
 * A {@link PaymentStore} backed by Lunora's own data layer.
 *
 * Rather than ship a bespoke `PaymentDO`, payment state rides the app's existing ShardDO: the
 * payment tables are declared INLINE in the app's own `lunora/schema.ts` (codegen discovers tables
 * by parsing that file, so it cannot resolve a cross-package `...paymentTables` spread — `./schema`
 * is the canonical column reference to mirror), and this store reads/writes them through a small
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
 * Bounded-read arguments for {@link PaymentDatabase.findMany}, mirroring what
 * Lunora's `ctx.db.findMany` already accepts. `where` stays equality-only — these
 * are the knobs that let a caller bound the number of rows FETCHED rather than
 * fetching everything and slicing afterwards.
 * @experimental
 */
interface PaymentPageArgs {
    /** Keyset cursor from a previous page's {@link PaymentPage.cursor}. */
    cursor?: string;
    /** Maximum rows to FETCH. Omit to read every match. */
    limit?: number;
    /** Sort keys, pushed down to the store so the keyset cursor is well-defined. */
    orderBy?: Record<string, "asc" | "desc">[];
}

/**
 * One page of rows plus the cursor that continues it.
 * @experimental
 */
interface PaymentPage {
    /** Cursor for the next page, or `undefined` when this was the last one. */
    readonly cursor: string | undefined;
    readonly rows: PaymentRow[];
}

/**
 * Minimal write/read surface this store needs; `ctx.db` satisfies it structurally.
 * @experimental
 */
interface PaymentDatabase {
    delete: (id: string) => Promise<void>;
    findFirst: (table: string, where: Record<string, unknown>) => Promise<PaymentRow | null>;

    /**
     * Equality-only `where`, with optional order/limit/cursor pushed DOWN to the
     * store (see {@link PaymentPageArgs}). Omitting `page` reads every match — do
     * that only where the match set is inherently small (one reference's rows).
     */
    findMany: (table: string, where: Record<string, unknown>, page?: PaymentPageArgs) => Promise<PaymentPage>;
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

const rowToUsageEvent = (row: PaymentRow): UsageEvent => {
    return {
        createdAt: readNumber(row, "createdAt"),
        featureId: readString(row, "featureId"),
        idempotencyKey: readString(row, "idempotencyKey"),
        // An absent `mode` is "add" — see `usageEventToRow`.
        mode: row["mode"] === "set" ? "set" : "add",
        provider: readString(row, "provider") as ProviderId,
        quantity: readNumber(row, "quantity"),
        referenceId: readString(row, "referenceId"),
        reportedToProvider: readBoolean(row, "reportedToProvider"),
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
            // Unbounded by design: one reference holds a handful of subscriptions.
            const { rows } = await database.findMany("subscriptions", { referenceId });

            return rows.map((row) => rowToSubscription(row));
        },

        listUnreportedUsage: async (provider, limit) => {
            const wanted = Math.max(0, Math.floor(limit));

            if (wanted === 0) {
                return [];
            }

            // The port's `where` is equality-only, so the additive/positive
            // predicate (see `PaymentStore.listUnreportedUsage`) still has to be
            // applied in memory — but the READ is bounded. Order and limit are
            // pushed DOWN via `PaymentPageArgs` and the keyset `cursor` walks the
            // rest, so a provider that has been down for a day costs `wanted`-sized
            // chunks instead of materialising its whole backlog in a 128 MiB
            // isolate to take `limit` rows off the front.
            //
            // `orderBy` reproduces the previous in-memory sort exactly (createdAt
            // asc, then idempotencyKey as the tiebreak) so "oldest first" and the
            // memory store's ordering still agree.
            const orderBy: Record<string, "asc" | "desc">[] = [{ createdAt: "asc" }, { idempotencyKey: "asc" }];
            const events: UsageEvent[] = [];
            let cursor: string | undefined;

            do {
                // eslint-disable-next-line no-await-in-loop -- keyset paging is inherently serial: the next cursor is only known once this page returns
                const page = await database.findMany("usageEvents", { provider, reportedToProvider: false }, { cursor, limit: wanted, orderBy });

                for (const row of page.rows) {
                    const event = rowToUsageEvent(row);

                    if (event.mode !== "set" && event.quantity > 0) {
                        events.push(event);

                        if (events.length === wanted) {
                            return events;
                        }
                    }
                }

                cursor = page.cursor;
            } while (cursor !== undefined);

            // ponytail: memory is bounded, total scan length is not. A `"set"` row
            // (and a non-positive `"add"`) never becomes reported, so it is a
            // permanent non-match this walk re-reads on every sweep. Upgrade path
            // when that prefix gets long: record never-forwardable rows as already
            // reported, or add a `(provider, reportedToProvider, createdAt)` index
            // so the scan starts past them.
            return events;
        },

        markEventProcessed: async (provider, eventId, type) => {
            const existing = await database.findFirst("events", { provider, providerEventId: eventId });

            if (existing) {
                return false;
            }

            // The unique `by_provider_event` index is the real race guard in the DO; a concurrent
            // insert of the same event id fails its OCC commit, so at most one caller wins.
            await database.insert("events", { processedAt: Date.now(), provider, providerEventId: eventId, type });

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
            const { rows } = await database.findMany("usageEvents", { featureId, referenceId });
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

        sumUsageByFeature: async (referenceId, featureIds, since) => {
            // NOTE: one read of the reference's full lifetime ledger, filtered and bucketed in
            // memory — O(events) total instead of O(events) per feature. For hot metered features,
            // add a per-period rollup row (or a createdAt-range query) so old periods aren't
            // re-scanned on every read.
            const { rows } = await database.findMany("usageEvents", { referenceId });
            const buckets = new Map<string, { createdAt: number; idempotencyKey: string; mode: "add" | "set"; quantity: number }[]>(
                featureIds.map((featureId) => [featureId, []]),
            );

            for (const row of rows) {
                if (readNumber(row, "createdAt") < since) {
                    continue;
                }

                buckets.get(typeof row["featureId"] === "string" ? row["featureId"] : "")?.push({
                    createdAt: readNumber(row, "createdAt"),
                    idempotencyKey: typeof row["idempotencyKey"] === "string" ? row["idempotencyKey"] : "",
                    mode: row["mode"] === "set" ? ("set" as const) : ("add" as const),
                    quantity: readNumber(row, "quantity"),
                });
            }

            return new Map([...buckets].map(([featureId, window]) => [featureId, foldUsage(window)]));
        },

        // Keyed on `(provider, referenceId)` — the same key `getCustomerByReference` reads and the
        // memory store writes — so a re-mint (race or provider-side customer replacement) updates the
        // reference's row in place instead of forking a second row the read path can never find.
        upsertCustomer: async (customer) => upsert("customers", { provider: customer.provider, referenceId: customer.referenceId }, customerToRow(customer)),

        upsertPaymentSession: async (session) =>
            upsert("paymentSessions", { provider: session.provider, providerSessionId: session.id }, sessionToRow(session)),

        upsertSubscription: async (subscription) =>
            upsert("subscriptions", { provider: subscription.provider, providerSubscriptionId: subscription.id }, subscriptionToRow(subscription)),
    };
};

export type { PaymentDatabase, PaymentPage, PaymentPageArgs, PaymentRow };
