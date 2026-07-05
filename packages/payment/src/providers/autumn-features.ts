/**
 * Autumn-native feature surface.
 *
 * The generic `PaymentAdapter` covers checkout, subscriptions, entitlements, and usage — the
 * cross-provider vocabulary. Autumn also ships concepts with no provider-agnostic equivalent:
 * `entities` (per-seat / per-workspace sub-customers with their own feature balances), `referrals`
 * (codes and redemptions), events analytics (query/aggregate a reference's raw usage over a range),
 * the product catalog, and a native checkout with Autumn-only options (free trials, prepaid feature
 * quantities, entity scoping, reward codes).
 *
 * These live in this companion facade — deliberately separate from `createAutumnAdapter` — so the
 * provider-agnostic path stays generic and only Autumn apps reach for them. Like the adapter, the
 * client is injected structurally (no `autumn-js` dependency). The facade mirrors the `autumn-js`
 * calling convention: top-level actions take a single params object carrying `customer_id`, while
 * sub-resource getters are positional (id first). If your client differs, pass a thin shim.
 *
 * SECURITY: unlike the `ctx.payments` facade, these methods do **not** authorize the caller — each
 * takes the `referenceId` (and `entityId`) positionally and trusts it. Before exposing any of them on
 * a request handler, check that the caller owns the reference by matching it against the
 * authenticated user; forwarding an unvalidated reference from the request is an app-layer IDOR. // secret-scanner:allow -- prose only, no secret
 *
 * Credit systems need no method here — Autumn models them as features, so credit balances flow
 * through the adapter's `checkEntitlement` / `getBalances` like any other feature.
 */
import { asRecord, readNumber, readString } from "../json";

/** A per-seat / per-workspace sub-customer with its own feature balances. */
interface AutumnEntity {
    readonly featureId?: string;
    readonly id: string;
    readonly name?: string;
    /** The raw provider record, for fields this facade does not normalize. */
    readonly raw: Record<string, unknown>;
}

interface CreateEntityInput {
    /** The feature the entity consumes a seat/allowance of (e.g. `"seats"`). */
    readonly featureId: string;
    /** Caller-chosen stable id; Autumn generates one when omitted. */
    readonly id?: string;
    readonly name?: string;
}

/** One point in a usage-events aggregation. */
interface UsageEventPoint {
    readonly count: number;
    readonly period?: string;
    readonly raw: Record<string, unknown>;
}

interface EventsListInput {
    /** Feature(s) to report on. */
    readonly featureId: ReadonlyArray<string> | string;
}

interface EventsAggregateInput extends EventsListInput {
    /** Time window to aggregate over (aggregate only — `list` ignores it, so it isn't accepted there). */
    readonly range?: "7d" | "24h" | "30d" | "90d" | "last_cycle";
}

/** A prepaid feature quantity purchased at checkout (e.g. buy 5 seats up front). */
interface PrepaidOption {
    readonly featureId: string;
    readonly quantity: number;
}

/** Autumn-native checkout — richer than the generic `createCheckout` (trials, prepaid, entities, rewards). */
interface AutumnCheckoutInput {
    /** Scope the checkout to a specific entity (seat/workspace) rather than the top-level customer. */
    readonly entityId?: string;
    /** Start on a free trial when the plan defines one. */
    readonly freeTrial?: boolean;
    /** Prepaid feature quantities to purchase up front. */
    readonly options?: ReadonlyArray<PrepaidOption>;
    readonly productId: string;
    /** A reward / referral code to apply. */
    readonly reward?: string;
    readonly successUrl?: string;
}

/** The subset of the Autumn SDK surface the native facade calls. A real `Autumn` instance satisfies it. */
interface AutumnFeaturesClientLike {
    /** Attach a product to a customer with native options (trials, prepaid quantities, rewards). */
    readonly attach: (parameters: Record<string, unknown>) => Promise<Record<string, unknown>>;
    readonly entities: {
        readonly create: (customerId: string, parameters: Record<string, unknown>) => Promise<Record<string, unknown>>;
        readonly delete: (customerId: string, entityId: string) => Promise<unknown>;
        readonly get: (customerId: string, entityId: string, parameters?: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    readonly events: {
        readonly aggregate: (parameters: Record<string, unknown>) => Promise<Record<string, unknown>>;
        readonly list: (parameters: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    readonly products: {
        readonly list: (parameters?: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    readonly referrals: {
        readonly createCode: (parameters: Record<string, unknown>) => Promise<Record<string, unknown>>;
        readonly redeemCode: (parameters: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
}

interface AutumnFeaturesOptions {
    readonly client: AutumnFeaturesClientLike;
}

const entityFrom = (record: Record<string, unknown>): AutumnEntity => {
    return {
        featureId: readString(record, "feature_id") ?? readString(record, "featureId"),
        id: readString(record, "id") ?? "",
        name: readString(record, "name"),
        raw: record,
    };
};

/** Autumn returns either an array under `list`/`data` or a bare array — normalize to points. */
const pointsFrom = (result: Record<string, unknown>): UsageEventPoint[] => {
    const list = result.list ?? result.data ?? result.events;
    const rows = Array.isArray(list) ? list : [];

    return rows.map((entry) => {
        const record = asRecord(entry);

        return { count: readNumber(record, "count") ?? readNumber(record, "value") ?? 0, period: readString(record, "period"), raw: record };
    });
};

/** The Autumn-native feature facade returned by {@link createAutumnFeatures}. */
interface AutumnFeatures {
    readonly checkout: (referenceId: string, input: AutumnCheckoutInput) => Promise<{ raw: Record<string, unknown>; url: string }>;
    readonly entities: {
        readonly create: (referenceId: string, input: CreateEntityInput) => Promise<AutumnEntity>;
        readonly delete: (referenceId: string, entityId: string) => Promise<void>;
        readonly get: (referenceId: string, entityId: string, expand?: ReadonlyArray<"invoices">) => Promise<AutumnEntity>;
    };
    readonly events: {
        readonly aggregate: (referenceId: string, input: EventsAggregateInput) => Promise<UsageEventPoint[]>;
        readonly list: (referenceId: string, input: EventsListInput) => Promise<UsageEventPoint[]>;
    };
    readonly products: {
        readonly list: (referenceId?: string) => Promise<Record<string, unknown>[]>;
    };
    readonly referrals: {
        readonly createCode: (referenceId: string, programId: string) => Promise<{ code: string; raw: Record<string, unknown> }>;
        readonly redeemCode: (referenceId: string, code: string) => Promise<Record<string, unknown>>;
    };
}

/**
 * Build the Autumn-native feature facade over an injected client. Companion to `createAutumnAdapter`;
 * share the same underlying `autumn-js` client between them.
 */
export const createAutumnFeatures = (options: AutumnFeaturesOptions): AutumnFeatures => {
    const { client } = options;

    return {
        /**
         * Native Autumn checkout — supports free trials, prepaid feature quantities, entity scoping,
         * and reward codes. Returns the hosted checkout URL (empty when Autumn applied the change
         * directly without a payment step).
         */
        checkout: async (referenceId: string, input: AutumnCheckoutInput): Promise<{ raw: Record<string, unknown>; url: string }> => {
            const result = await client.attach({
                customer_id: referenceId,
                entity_id: input.entityId,
                free_trial: input.freeTrial,
                options: input.options?.map((option) => {
                    return { feature_id: option.featureId, quantity: option.quantity };
                }),
                product_id: input.productId,
                reward: input.reward,
                success_url: input.successUrl,
            });
            const url =
                readString(result, "checkout_url") ??
                readString(result, "checkoutUrl") ??
                readString(result, "payment_url") ??
                readString(result, "paymentUrl") ??
                readString(result, "url") ??
                "";

            return { raw: result, url };
        },

        entities: {
            /** Create a per-seat / per-workspace sub-customer under a reference. */
            create: async (referenceId: string, input: CreateEntityInput): Promise<AutumnEntity> => {
                const created = await client.entities.create(referenceId, { feature_id: input.featureId, id: input.id, name: input.name });

                return entityFrom(created);
            },

            /** Remove an entity — frees its seat/allowance. */
            delete: async (referenceId: string, entityId: string): Promise<void> => {
                await client.entities.delete(referenceId, entityId);
            },

            /** Fetch one entity and its balances. Pass `expand: ["invoices"]` for billing detail. */
            get: async (referenceId: string, entityId: string, expand?: ReadonlyArray<"invoices">): Promise<AutumnEntity> => {
                const entity = await client.entities.get(referenceId, entityId, expand ? { expand } : undefined);

                return entityFrom(entity);
            },
        },

        events: {
            /** Bucketed usage aggregation for a reference's feature(s) over a range. */
            aggregate: async (referenceId: string, input: EventsAggregateInput): Promise<UsageEventPoint[]> => {
                const result = await client.events.aggregate({ customer_id: referenceId, feature_id: input.featureId, range: input.range });

                return pointsFrom(result);
            },

            /** Raw usage events for a reference's feature(s). */
            list: async (referenceId: string, input: EventsListInput): Promise<UsageEventPoint[]> => {
                const result = await client.events.list({ customer_id: referenceId, feature_id: input.featureId });

                return pointsFrom(result);
            },
        },

        products: {
            /** The configured product/plan catalog (optionally scoped to a reference's eligibility). */
            list: async (referenceId?: string): Promise<Record<string, unknown>[]> => {
                const result = await client.products.list(referenceId ? { customer_id: referenceId } : undefined);
                const list = result.list ?? result.data ?? result.products;

                return Array.isArray(list) ? list.map((entry) => asRecord(entry)) : [];
            },
        },

        referrals: {
            /** Mint a referral code for a reference in a referral program. */
            createCode: async (referenceId: string, programId: string): Promise<{ code: string; raw: Record<string, unknown> }> => {
                const result = await client.referrals.createCode({ customer_id: referenceId, program_id: programId });

                return { code: readString(result, "code") ?? "", raw: result };
            },

            /** Redeem a referral code on behalf of a reference. */
            redeemCode: async (referenceId: string, code: string): Promise<Record<string, unknown>> =>
                client.referrals.redeemCode({ code, customer_id: referenceId }),
        },
    };
};

export type {
    AutumnCheckoutInput,
    AutumnEntity,
    AutumnFeatures,
    AutumnFeaturesClientLike,
    AutumnFeaturesOptions,
    CreateEntityInput,
    EventsAggregateInput,
    EventsListInput,
    PrepaidOption,
    UsageEventPoint,
};
